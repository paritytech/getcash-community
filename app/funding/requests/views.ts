// Pure projections of a request record onto the values the session store exposes today, so the
// screens and the list adapters read the same things from the new record.

import type { PaymentPhase, SwapProgress } from "@getsome/core";
import type { FundingStep } from "@getsome/funding";
import type { RequestStatus as LegacyRequestStatus } from "../../stores/session";
import type { FundingProgressProjection } from "../progress";
import { creditedAmount } from "../top-up-projection";
import type { FundingTopUpState } from "../top-ups";
import {
  CONFIRMED_TTL_MS,
  DEPOSIT_EXPIRED_REASON,
  rankOf,
  type Freshness,
  type RequestRecord,
} from "./model";

/** Today's list status. Undefined where the record's legacy fields already carry the state. */
export function legacyRequestStatus(record: RequestRecord): LegacyRequestStatus | undefined {
  const { status } = record;
  switch (status.kind) {
    case "converting":
      return { kind: "converting", step: status.step };
    case "claiming":
      return { kind: "converting", step: "done" };
    case "failed":
      return {
        kind: "failed",
        reason: record.failure?.message ?? record.failureReason ?? "",
        ...(record.refunded === undefined ? {} : { refunded: record.refunded }),
      };
    case "expired":
      return { kind: "failed", reason: DEPOSIT_EXPIRED_REASON };
    default:
      return undefined;
  }
}

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

export function swapOf(record: RequestRecord): SwapProgress | null {
  if (phaseLike(record) !== "swapping" || record.rail.status === "failed") return null;
  return record.rail.status;
}

/** How many of the journey's five markers (Started, Payment, Approved, Conversion, Added) are
 *  complete, 1..5. The payment leg is the route's own; the money leg is the same for every route,
 *  so a deposit seen by any witness reads the same everywhere. */
export function journeyStepsOf(record: RequestRecord): number {
  const { status, rail, failure } = record;
  switch (status.kind) {
    case "awaiting-deposit":
    case "expired":
    case "cancelled":
      return 1;
    case "deposit-seen":
      // Money on the address, or the rail delivered it: the payment is approved. A sighting on
      // the provider's side is a payment received and no more.
      return status.via === "worker" ||
        status.via === "faucet" ||
        status.via === "chain" ||
        status.via === "pre-cancel" ||
        rail.stage === "delivered"
        ? 3
        : 2;
    case "converting":
      return 3;
    case "claiming":
      return 4;
    case "settled":
      return 5;
    case "failed":
      if (failure?.step === "mint") return 4;
      if (failure?.step === "swap") return 3;
      switch (failure?.kind) {
        case "refunded":
        case "refund-failed":
        case "egress-failed":
        case "fallback-egress":
          return 2; // the network took the payment but could not deliver
        default:
          return 1;
      }
  }
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
