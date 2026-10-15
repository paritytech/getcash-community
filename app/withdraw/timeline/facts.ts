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

/** The worker filed a transaction of this call from the key. */
function workerFiled(record: WithdrawalRecord, call: "swap" | "withdraw" | "pay"): boolean {
  const worker = record.witnesses.worker;
  return worker?.known === true && (worker.txs?.some((tx) => tx.call === call) ?? false);
}

/** The rail saw the key's payment: it reports the deposit at or past `received`. */
function railSawPayment(record: WithdrawalRecord): boolean {
  const { stage } = record.rail;
  return stage === "received" || stage === "processing" || stage === "delivered";
}

/** The key paid the rail: the worker filed the payment, the rail saw it, or the rail ended in a
 *  way only possible with the funds. */
export function handedToRail(record: WithdrawalRecord): boolean {
  if (railSawPayment(record)) return true;
  const kind = railFailureKind(record);
  if (kind !== undefined && RAIL_HAD_FUNDS.has(kind)) return true;
  return workerFiled(record, "pay");
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

/** The conversion on the key is done and the arrival on Asset Hub awaited: the worker is at that
 *  step, or it filed the XCM out of People, which outlives a failure on the way. */
function arrivalAwaited(record: WithdrawalRecord): boolean {
  const { status } = record;
  if (status.kind === "converting") {
    return SENDING_STEP_ORDER[status.step] >= SENDING_STEP_ORDER["await-arrival"];
  }
  return workerFiled(record, "withdraw");
}

const fact = (at: number | null | undefined): Fact => (at == null ? {} : { at });

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
  if (rank >= 2 && arrivalAwaited(record)) {
    reached.converted = fact(status.kind === "converting" ? status.at : undefined);
  }
  if (rank >= 3) {
    reached.converted = {};
    reached.moved = fact(status.kind === "sending" ? status.at : undefined);
    // The rail's stamp is its last change, so it dates the last of its milestones reached, which
    // is the one the current line is timed from. Before the rail sees the key's payment its last
    // change is the leg's opening, so a hand-off the worker alone vouches for is timed from there
    // rather than standing still until the rail reports.
    if (railDispatched(record)) {
      reached.handed = {};
      reached.processed = {};
      reached.dispatched = fact(rail.updatedAt);
    } else if (railSendingOn(record)) {
      reached.handed = {};
      reached.processed = fact(rail.updatedAt);
    } else if (handedToRail(record)) {
      reached.handed = fact(rail.updatedAt);
    }
  }
  return reached;
}
