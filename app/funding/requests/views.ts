// Pure projections of a request record onto the values the session store exposes today, so the
// screens and the list adapters read the same things from the new record.

import type { FailureKind, PaymentPhase } from "@getsome/core";
import type { FundingStep } from "@getsome/funding";
import { fmtCash } from "../../utils/cash";
import type { FundingTopUpState } from "../top-ups";
import {
  CONFIRMED_TTL_MS,
  isFinished,
  rankOf,
  type Freshness,
  type RequestRecord,
  type TopUpRecord,
} from "./model";

/** The core phase the record stands in for. */
export function phaseLike(record: TopUpRecord): PaymentPhase {
  const { status, rail } = record;
  switch (status.kind) {
    case "settled":
      return "done";
    case "claiming":
      return record.creditedAt === undefined ? "working" : "done";
    case "failed":
    case "expired":
      return "failed";
    case "cancelled":
      return "idle";
    case "deposit-seen":
      // A rail's own sighting drives core's `swapping` on every rail but the manual one.
      return (status.via === "rail" || status.via === "core") && rail.provider !== "manual"
        ? "swapping"
        : "awaiting-deposit";
    case "converting":
      return "swapping";
    default:
      return "awaiting-deposit";
  }
}

/** A base-unit amount above zero. */
const positiveBase = (amount: string | undefined): bigint | undefined =>
  amount !== undefined && /^\d+$/.test(amount) && BigInt(amount) > 0n ? BigInt(amount) : undefined;

/** The CASH the Host minted on the claim so far, as the worker last reported it. */
export function mintedOf(record: TopUpRecord): bigint | undefined {
  const worker = record.witnesses.worker;
  return worker?.known ? positiveBase(worker.claimCredited) : undefined;
}

/** What the Host credited, once the top-up ended with a credit: the claim on success, what it
 *  minted before a claim that failed. Absent before the end. */
export function creditedAmountOf(record: TopUpRecord): string | undefined {
  const credited =
    phaseLike(record) === "done"
      ? positiveBase(record.claimed)
      : record.status.kind === "failed"
        ? mintedOf(record)
        : undefined;
  return credited === undefined ? undefined : fmtCash(credited);
}

/** Today's step comes from the worker's job; a core, rail or chain sighting sets none. A side exit reports the leg it kept the rank of. */
export function fundingStepOf(record: TopUpRecord): FundingStep | null {
  const { status } = record;
  switch (status.kind) {
    case "converting":
      return status.step;
    case "claiming":
    case "settled":
      return "done";
    case "deposit-seen":
      return status.via === "worker" ? "swap" : null;
    case "failed":
    case "expired":
    case "cancelled":
      return record.failure?.step === "mint"
        ? "done"
        : record.failure?.step === "swap"
          ? "swap"
          : null;
    default:
      return null;
  }
}

/** Today's latch: a worker step past `await-native`, or the burner read a cancel refused on. */
export const fundsSeenOf = (record: TopUpRecord): boolean =>
  rankOf(record) >= 2 ||
  (record.status.kind === "deposit-seen" &&
    (record.status.via === "worker" || record.status.via === "pre-cancel"));

/** A failure that closed the deposit window with nothing paid, as against a payment that went
 *  wrong. The design names the step itself ("Expired") and shows no money rows, so the two endings
 *  have to stay apart on the record as well as in the live world. */
export const expiredFailure = (kind?: FailureKind): boolean =>
  kind === "expired" || kind === "stale";

/** The list row's state, a running one worded by `label`. A cancelled record is never listed; it
 *  reads as failed so the type has a value. */
export function rowStateOf(record: TopUpRecord, label: string): FundingTopUpState {
  const { status } = record;
  switch (status.kind) {
    case "settled":
      return {
        kind: "settled",
        at: record.settledAt ?? status.at,
        creditedAmount: creditedAmountOf(record) ?? record.amountHuman,
      };
    case "failed":
    case "expired": {
      const reason = record.failure?.message ?? record.failureReason;
      // A refund's own figures, for a journey reopened from history: without them it can say only
      // that a refund happened, not how much came back or where to look for it.
      const refunded = record.refunded === true;
      const refund = record.failure?.refund;
      // The status is the rail's own word on an expiry; the failure's kind covers a record whose
      // status stayed `failed` because the expiry came back from core rather than the deadline.
      const expired = status.kind === "expired" || expiredFailure(record.failure?.kind);
      const credited = creditedAmountOf(record);
      return {
        kind: "failed",
        at: status.at,
        ...(expired ? { expired: true } : {}),
        ...(credited === undefined ? {} : { creditedAmount: credited }),
        ...(reason === undefined ? {} : { reason }),
        ...(refunded ? { refunded: true } : {}),
        ...(refunded && refund?.amount ? { refundAmount: refund.amount } : {}),
        ...(refunded && refund?.txRef ? { refundTxRef: refund.txRef } : {}),
      };
    }
    case "cancelled":
      return { kind: "failed", at: status.at, reason: "Cancelled" };
    case "awaiting-deposit":
      return { kind: "awaiting-transfer", status: label };
    case "claiming":
      if (record.creditedAt !== undefined) {
        return {
          kind: "settled",
          at: record.creditedAt,
          creditedAmount: creditedAmountOf(record) ?? record.amountHuman,
        };
      }
      return { kind: "finishing", status: label };
    case "deposit-seen":
    case "converting":
      return { kind: "finishing", status: label };
  }
}

export function meldStageOf(
  record: TopUpRecord,
): "waiting" | "receiving" | "complete" | "failed" | null {
  const { rail } = record;
  if (rail.provider !== "meld") return null;
  if (rail.stage === "failed") return "failed";
  if (rail.stage === "delivered") return "complete";
  // The buyer's own paid stamp hands the widget over, not the provider's first sighting: a
  // challenge may still follow that.
  return record.meldSubmittedAt === undefined ? "waiting" : "receiving";
}

/** The journey took over from the widget: the buyer submitted, or the payment completed. */
export const meldHandedOffOf = (record: TopUpRecord): boolean =>
  record.meldSubmittedAt !== undefined || record.rail.stage === "delivered";

/** The claim is still in flight: registered, and not yet reported in a block by the host. */
export const claimingOf = (record: TopUpRecord): boolean =>
  record.status.kind === "claiming" && record.creditedAt === undefined;

/** Confirmed by a read since `epoch` that has not aged past the TTL (a finished record's never
 *  does); otherwise reconciling while a pass runs, else the cache as it was left. */
export function freshnessOf(
  record: RequestRecord,
  tick: number,
  epoch: number,
  reconciling: boolean,
): Freshness {
  const { confirmedAt } = record;
  if (
    confirmedAt !== undefined &&
    confirmedAt >= epoch &&
    (isFinished(record) || tick - confirmedAt < CONFIRMED_TTL_MS)
  ) {
    return "confirmed";
  }
  return reconciling ? "reconciling" : "cached";
}
