// The withdrawal's milestones, read from the record's status, its rail and the worker's witness.
// Only the current status keeps its stamp, so a milestone's time is known for the leg the record
// is on; a reached milestone implies every milestone before it, so earlier lines draw full.

import {
  SENDING_STEP_ORDER,
  withdrawalRankOf,
  type WithdrawalFailureKind,
  type WithdrawalRecord,
} from "../../funding/requests/model";
import type { Fact, ReachedMilestones } from "../../funding/timeline/types";
import type { WithdrawalMilestone } from "./spec";

/** The rail's endings that prove it had the funds. */
const RAIL_HAD_FUNDS: ReadonlySet<WithdrawalFailureKind> = new Set([
  "refunded",
  "egress-failed",
  "fallback-egress",
  "deposit-rejected",
]);

/** The rail's endings that prove it was sending on. */
const RAIL_SENT_ON: ReadonlySet<WithdrawalFailureKind> = new Set([
  "egress-failed",
  "fallback-egress",
]);

const railFailureKind = (record: WithdrawalRecord): WithdrawalFailureKind | undefined =>
  record.failure?.step === "send" ? record.failure.kind : undefined;

/** The worker filed a transaction of this call from the key and the chain took it. */
function workerFiled(
  record: WithdrawalRecord,
  call: "swap" | "withdraw" | "pay" | "sweep",
): boolean {
  const worker = record.witnesses.worker;
  return worker?.known === true && (worker.txs?.some((tx) => tx.call === call && tx.ok) ?? false);
}

/** The rail saw the key's payment: it reports the deposit at or past `received`, or did before
 *  it failed. */
function railSawPayment(record: WithdrawalRecord): boolean {
  const { stage, stageAt } = record.rail;
  if (stage === "received" || stage === "processing" || stage === "delivered") return true;
  return stageAt?.received !== undefined || stageAt?.processing !== undefined;
}

/** The rail has the funds: the worker filed the payment (Meld) or swept the key to it (Chainflip),
 *  the rail saw it, or the rail ended in a way only possible with the funds. Every tier lands the
 *  sale on the key first, provider rails included: only a `direct` destination is paid by the XCM
 *  itself. A sale's provider is only followed once paid, so any ending it reports is one. */
export function receivedByRail(record: WithdrawalRecord): boolean {
  if (railSawPayment(record)) return true;
  const { rail } = record;
  if (rail.provider === "meld" && rail.stage === "failed" && rail.failure !== undefined)
    return true;
  const kind = railFailureKind(record);
  if (kind !== undefined && RAIL_HAD_FUNDS.has(kind)) return true;
  return workerFiled(record, "pay") || workerFiled(record, "sweep");
}

/** The rail is sending on, or tried to: the swap is done, the payout approved. */
function railSendingOn(record: WithdrawalRecord): boolean {
  const { stage, status } = record.rail;
  if (stage === "delivered") return true;
  if (status === "sending" || status === "sent" || status === "complete") return true;
  const kind = railFailureKind(record);
  return kind !== undefined && RAIL_SENT_ON.has(kind);
}

/** The rail sent, and the funds are on their way to the destination. */
function railDispatched(record: WithdrawalRecord): boolean {
  const { stage, status } = record.rail;
  return stage === "delivered" || status === "sent" || status === "complete";
}

/** The key filed the XCM out of People and the arrival on Asset Hub is awaited: the worker is at
 *  that step, or it filed the call, which outlives a failure on the way and the retry after it. */
function xcmDeparted(record: WithdrawalRecord): boolean {
  const { status } = record;
  if (
    status.kind === "converting" &&
    SENDING_STEP_ORDER[status.step] >= SENDING_STEP_ORDER["await-arrival"]
  ) {
    return true;
  }
  return workerFiled(record, "withdraw");
}

const fact = (at: number | null | undefined): Fact => (at == null ? {} : { at });

/** When the leg the record is on opened: the status's own stamp, or the one a failure kept. */
function legOpenedAt({ status }: WithdrawalRecord): number | undefined {
  if (status.kind === "failed") return status.legAt;
  return status.kind === "converting" || status.kind === "sending" ? status.at : undefined;
}

export function withdrawalMilestones(
  record: WithdrawalRecord,
): ReachedMilestones<WithdrawalMilestone> {
  const { status, rail } = record;
  const rank = withdrawalRankOf(record);
  const worker = record.witnesses.worker;
  const reached: Partial<Record<WithdrawalMilestone, Fact>> = {};

  if (status.kind === "sent") {
    // Everything before Sent is implied; the direct rail never reports the legs between.
    return { started: {}, sent: { at: status.at } };
  }
  if (rank >= 1) {
    reached.started = fact(
      (worker?.known ? worker.fundsSeenAt : undefined) ??
        (status.kind === "paid" ? status.at : undefined),
    );
  }
  if (rank >= 2 && xcmDeparted(record)) {
    reached.departed = fact(legOpenedAt(record));
  }
  if (rank >= 3) {
    reached.departed = {};
    reached.converted = fact(legOpenedAt(record));
    // The last milestone reached dates the current line. The rail stamps the stages it saw;
    // its last change dates a hand-off the worker alone vouches for, which is then the leg's
    // opening, so the line moves rather than standing still until the rail reports. A failure
    // overwrites that stamp, so a failed rail falls back to the stage stamps and the leg.
    const { stageAt } = rail;
    const lastChange = rail.stage === "failed" ? undefined : rail.updatedAt;
    const received = stageAt?.received ?? stageAt?.processing ?? lastChange ?? legOpenedAt(record);
    // Sending on, not the swap the processing stage also covers.
    const sendingOn = stageAt?.sending ?? lastChange ?? received;
    if (railDispatched(record)) {
      reached.received = {};
      reached.processed = {};
      reached.dispatched = fact(rail.updatedAt);
    } else if (railSendingOn(record)) {
      reached.received = {};
      reached.processed = fact(sendingOn);
    } else if (receivedByRail(record)) {
      reached.received = fact(received);
    }
  }
  return reached;
}
