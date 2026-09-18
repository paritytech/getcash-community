// Pure projections of a request record onto the values the session store exposes today, so the
// screens and the list adapters read the same things from the new record.

import type { FailureKind, PaymentPhase } from "@getsome/core";
import type { FundingStep } from "@getsome/funding";
import type { FundingProgressProjection } from "../progress";
import { creditedAmount } from "../top-up-projection";
import type { FundingTopUpState } from "../top-ups";
import {
  CONFIRMED_TTL_MS,
  PAYMENT_WATCH_MS,
  rankOf,
  TOMBSTONE_GRACE_MS,
  type Freshness,
  type RequestRecord,
} from "./model";

/** The core phase the record stands in for. */
export function phaseLike(record: RequestRecord): PaymentPhase {
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
export function fundingStepOf(record: RequestRecord): FundingStep | null {
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
export const fundsSeenOf = (record: RequestRecord): boolean =>
  rankOf(record) >= 2 ||
  (record.status.kind === "deposit-seen" &&
    (record.status.via === "worker" ||
      record.status.via === "faucet" ||
      record.status.via === "pre-cancel"));

/**
 * Until when a request whose payment has not been seen is watched: the rail is still worth asking,
 * and the record is still worth keeping.
 *
 * The rail's own expiry only ever extends this, never shortens it. A pay page that closed says
 * nothing about a transfer already sent, so the window is measured from when the request started
 * and sized to outlast the adapter's watch (see `PAYMENT_WATCH_MS`).
 */
export const paymentWatchUntil = (record: Pick<RequestRecord, "startedAt" | "deadline">): number =>
  Math.max(record.startedAt + PAYMENT_WATCH_MS, record.deadline.depositExpiresAt ?? 0) +
  TOMBSTONE_GRACE_MS;

/** The scale a route's journey is drawn and counted on: each names its own stops. */
export type JourneyScale = "crypto" | "card" | "bank";

/** The scale a route's journey is counted on. */
export const journeyScaleOf = (route: RequestRecord["route"]): JourneyScale =>
  route === "crypto" ? "crypto" : route === "bank" ? "bank" : "card";

/** The stops each scale draws, in order. The bank transfer has no "Approved" of its own: nothing
 *  can be approved before the money lands, and the conversion that follows is over in the same
 *  breath, so the design draws the wait as one step. */
export const JOURNEY_STAGES: Record<JourneyScale, readonly string[]> = {
  crypto: ["Started", "Conversion", "Added"],
  card: ["Started", "Payment", "Approved", "Conversion", "Added"],
  bank: ["Started", "Payment", "Added"],
};

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
function cryptoJourneySteps(record: RequestRecord): number {
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
function cardJourneySteps(record: RequestRecord): number {
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

/** How many of the bank journey's three markers are complete, 1..3. Started: the request exists,
 *  so a transfer still to arrive counts one — the buyer has been given the details to pay. Payment:
 *  the money was seen, whoever saw it. Added: the request settled. The conversion sits inside
 *  "Payment": from the buyer's side the transfer is the wait, and what follows it is not theirs to
 *  watch. */
function bankJourneySteps(record: RequestRecord): number {
  const { status, failure } = record;
  switch (status.kind) {
    case "awaiting-deposit":
      return 1;
    case "deposit-seen":
    case "converting":
    case "claiming":
      return 2;
    case "settled":
      return 3;
    case "failed":
    case "expired":
    case "cancelled":
      // Past the deposit the money was taken, whatever the leg it then failed on.
      if (failure?.step === "mint" || failure?.step === "swap") return 2;
      return paymentTaken(failure?.kind) ? 2 : 1;
  }
}

/**
 * The markers the timeline draws as complete, which is not always what the record counted.
 *
 * The crypto journey opens on the first sighting — its "Started" marker *is* the deposit — so a
 * failure with nothing detected has nothing behind it. The fiat scales count "Started" as the
 * request itself, which exists whatever the payment did, so their count stands as recorded: a
 * declined transfer is a failure at "Payment", not at the beginning.
 */
export function completedMarkers(
  scale: JourneyScale,
  counted: number,
  failed: { failed: boolean; detected: boolean },
): number {
  const floor = Math.max(counted, 0);
  if (scale !== "crypto") return floor;
  return failed.failed && !failed.detected ? 0 : floor;
}

/** How many of the journey's markers are complete, on the scale the route shows. */
export function journeyStepsOf(record: RequestRecord, scale: JourneyScale): number {
  if (scale === "crypto") return cryptoJourneySteps(record);
  return scale === "bank" ? bankJourneySteps(record) : cardJourneySteps(record);
}

/** The list row's state, worded by the same progress projection the journey ribbon shows. A
 *  cancelled record is never listed; it reads as failed so the type has a value. */
export function rowStateOf(
  record: RequestRecord,
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
      return {
        kind: "failed",
        at: status.at,
        ...(reason === undefined ? {} : { reason }),
        ...(record.refunded === true ? { refunded: true } : {}),
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
  record: RequestRecord,
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
export const meldHandedOffOf = (record: RequestRecord): boolean =>
  record.meldSubmittedAt !== undefined || record.rail.stage === "delivered";

/** When each journey step landed, by step number. */
export function milestonesOf(record: RequestRecord): Record<number, number> {
  const { progress } = record;
  const milestones: Record<number, number> = { 1: record.startedAt };
  if (progress.detectedAt !== undefined) milestones[2] = progress.detectedAt;
  const converted = progress.stageTimestamps["cash-conversion"];
  if (converted !== undefined) milestones[4] = converted;
  if (record.settledAt !== undefined) milestones[5] = record.settledAt;
  return milestones;
}

export const claimingOf = (record: RequestRecord): boolean => record.status.kind === "claiming";

/** Confirmed by a read since `epoch` that has not aged past the TTL (a settled record's never
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
    (record.status.kind === "settled" || tick - confirmedAt < CONFIRMED_TTL_MS)
  ) {
    return "confirmed";
  }
  return reconciling ? "reconciling" : "cached";
}
