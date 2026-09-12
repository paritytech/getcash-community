// Pure projections of a request record onto the values the session store exposes today, so the
// screens and the list adapters read the same things from the new record.

import type { PaymentPhase, SwapProgress } from "@getsome/core";
import type { FundingStep } from "@getsome/funding";
import type { RequestStatus as LegacyRequestStatus } from "../../stores/session";
import type { JourneyInput } from "../../utils/journey";
import { DEPOSIT_EXPIRED_REASON, rankOf, type RequestRecord } from "./model";

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

/** Today's latch: a worker step past `await-native`, or the faucet's transfer. */
export const fundsSeenOf = (record: RequestRecord): boolean =>
  rankOf(record) >= 2 ||
  (record.status.kind === "deposit-seen" &&
    (record.status.via === "worker" || record.status.via === "faucet"));

export function swapOf(record: RequestRecord): SwapProgress | null {
  if (phaseLike(record) !== "swapping" || record.rail.status === "failed") return null;
  return record.rail.status;
}

/** The exact object `journeyDone` takes today. */
export function journeyInput(record: RequestRecord): JourneyInput {
  return {
    phase: phaseLike(record),
    fundingStep: fundingStepOf(record),
    swap: swapOf(record),
    failure: record.failure ? { kind: record.failure.kind } : null,
  };
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
