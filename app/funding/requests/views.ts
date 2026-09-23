// Pure projections of a request record onto the values the session store exposes today, so the
// screens and the list adapters read the same things from the new record.

import type { FailureKind, PaymentPhase } from "@getsome/core";
import type { FundingStep } from "@getsome/funding";
import type { FundingProgressProjection } from "../progress";
import { creditedAmount } from "../top-up-projection";
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
      return "working";
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

/** Today's step comes from the worker's job or the faucet; a core, rail or chain sighting sets
 *  none. A side exit reports the leg it kept the rank of. */
export function fundingStepOf(record: TopUpRecord): FundingStep | null {
  const { status } = record;
  switch (status.kind) {
    case "converting":
      return status.step;
    case "claiming":
    case "settled":
      return "done";
    case "deposit-seen":
      return status.via === "worker" || status.via === "faucet" ? "swap" : null;
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

/** Today's latch: a worker step past `await-native`, the faucet's transfer, or the burner read a
 *  cancel refused on. */
export const fundsSeenOf = (record: TopUpRecord): boolean =>
  rankOf(record) >= 2 ||
  (record.status.kind === "deposit-seen" &&
    (record.status.via === "worker" ||
      record.status.via === "faucet" ||
      record.status.via === "pre-cancel"));

/** How many steps the route's journey shows: three on the crypto timeline, five on the card's. */
export type JourneySteps = 3 | 5;

/** The scale a route's journey is counted on. */
export const journeyScaleOf = (route: TopUpRecord["route"]): JourneySteps =>
  route === "crypto" ? 3 : 5;

/** A failure that closed the deposit window with nothing paid, as against a payment that went
 *  wrong. The design names the step itself ("Expired") and shows no money rows, so the two endings
 *  have to stay apart on the record as well as in the live world. */
export const expiredFailure = (kind?: FailureKind): boolean =>
  kind === "expired" || kind === "stale";

/** A side exit's kind: the network took the payment even though it could not deliver it. */
const paymentTaken = (kind?: FailureKind): boolean =>
  kind === "refunded" ||
  kind === "refund-failed" ||
  kind === "egress-failed" ||
  kind === "fallback-egress";

/** How many of the crypto journey's three markers are complete, 0..3. The scale starts at 0: the
 *  journey only opens once the deposit is seen, and until then the deposit screen is showing.
 *  Started: the deposit was seen at a best block, whatever its assurance. Conversion: the worker
 *  reported `done`, so the one program that swaps and teleports is behind the record and the
 *  claim has started. Added: the request settled. A side exit reports the leg it left; from the
 *  deposit, the kind says whether the network took the payment. */
function cryptoJourneySteps(record: TopUpRecord): number {
  const { status, failure } = record;
  switch (status.kind) {
    case "awaiting-deposit":
      return 0;
    case "deposit-seen":
    case "converting":
      return 1;
    case "claiming":
      return 2;
    case "settled":
      return 3;
    case "failed":
    case "expired":
    case "cancelled":
      if (failure?.step === "mint") return 2;
      if (failure?.step === "swap") return 1;
      return paymentTaken(failure?.kind) ? 1 : 0;
  }
}

/** How many of the card and bank journey's five markers are complete, 1..5. Started: the request
 *  exists, so a record awaiting its payment counts one. Payment: the provider reported the
 *  payment. Approved: the deposit is on the burner at finality. Conversion: the worker reported
 *  `done`, since the swap and the teleport are one program. Added: the request settled. */
function cardJourneySteps(record: TopUpRecord): number {
  const { status, failure } = record;
  switch (status.kind) {
    case "awaiting-deposit":
      return 1;
    case "deposit-seen":
      // "Approved" waits for finality on the burner: a rail's delivery on its own is a payment
      // received and no more.
      return status.assurance === "finalized" ? 3 : 2;
    case "converting":
      return 3;
    case "claiming":
      return 4;
    case "settled":
      return 5;
    case "failed":
    case "expired":
    case "cancelled":
      if (failure?.step === "mint") return 4;
      if (failure?.step === "swap") return 3;
      return paymentTaken(failure?.kind) ? 2 : 1;
  }
}

/** How many of the journey's markers are complete, on the scale the route shows. */
export function journeyStepsOf(record: TopUpRecord, steps: JourneySteps): number {
  return steps === 3 ? cryptoJourneySteps(record) : cardJourneySteps(record);
}

/** The list row's state, worded by the same progress projection the journey ribbon shows. A
 *  cancelled record is never listed; it reads as failed so the type has a value. */
export function rowStateOf(
  record: TopUpRecord,
  progress: FundingProgressProjection,
): FundingTopUpState {
  const { status } = record;
  switch (status.kind) {
    case "settled":
      return {
        kind: "settled",
        at: record.settledAt ?? status.at,
        creditedAmount: creditedAmount(record),
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
      return {
        kind: "failed",
        at: status.at,
        ...(expired ? { expired: true } : {}),
        ...(reason === undefined ? {} : { reason }),
        ...(refunded ? { refunded: true } : {}),
        ...(refunded && refund?.amount ? { refundAmount: refund.amount } : {}),
        ...(refunded && refund?.txRef ? { refundTxRef: refund.txRef } : {}),
      };
    }
    case "cancelled":
      return { kind: "failed", at: status.at, reason: "Cancelled" };
    case "awaiting-deposit":
      return { kind: "awaiting-transfer", status: progress.view.label };
    case "deposit-seen":
    case "converting":
    case "claiming":
      return { kind: "finishing", status: progress.view.label };
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

/** When each journey step landed, by step number. */
export function milestonesOf(record: TopUpRecord): Record<number, number> {
  const { progress } = record;
  const milestones: Record<number, number> = { 1: record.startedAt };
  if (progress.detectedAt !== undefined) milestones[2] = progress.detectedAt;
  const converted = progress.stageTimestamps["cash-conversion"];
  if (converted !== undefined) milestones[4] = converted;
  if (record.settledAt !== undefined) milestones[5] = record.settledAt;
  return milestones;
}

export const claimingOf = (record: TopUpRecord): boolean => record.status.kind === "claiming";

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
