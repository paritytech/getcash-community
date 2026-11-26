// The rail leg: a provider's normalised status folded onto the generic stage the shell
// reads, and the merge that keeps that stage monotonic. Shared by the deposit and the
// withdrawal, whose rails differ only in the providers they name.

import {
  RAIL_FAILED_MESSAGE,
  type RailFailureInfo,
  type SwapProgress,
  type SwapStatusResult,
} from "@getsome/core";
import type { RailState } from "./model";

type RailStage = RailState["stage"];
type RailFailure = NonNullable<RailState["failure"]>;

/** What one provider read says, for any provider name. */
export interface RailReading<P extends string> {
  provider: P;
  status: SwapProgress | "failed";
  stage: RailStage;
  delayed?: boolean;
  failure?: RailFailure;
  updatedAt: number;
}

/** What `mergeRail` needs of a rail: its stage, and the status and delay a read carries. */
interface RailLike {
  stage: RailStage;
  status?: SwapProgress | "failed";
  delayed?: boolean;
  updatedAt: number;
}

/** waiting < received < processing < delivered; `failed` is a sink reached from any stage. */
const STAGE_RANK: Record<RailStage, number> = {
  waiting: 0,
  received: 1,
  processing: 2,
  delivered: 3,
  failed: 4,
};

export const stageRank = (stage: RailStage): number => STAGE_RANK[stage];

function stageOf(result: SwapStatusResult): RailStage {
  // A failure the rail names ends the leg whatever its top-level status says.
  if (result.depositFailure) return "failed";
  switch (result.status) {
    case "waiting":
      return "waiting";
    case "receiving":
      return "received";
    case "swapping":
    case "sending":
    case "sent":
      return "processing";
    case "complete":
      return "delivered";
    case "failed":
      return "failed";
  }
}

/** The ending's own code, when the rail named one. */
const code = (failure: RailFailureInfo): { code?: string } =>
  failure.reason?.code === undefined ? {} : { code: failure.reason.code };

/** `mapRailFailure` from `packages/core/src/session.ts`, which core does not export, reduced
 *  to the kind and message. Keep the two in step. */
function railFailure(result: SwapStatusResult): RailFailure {
  if (result.depositFailure) {
    // The rail's own kind, code and message take precedence over the defaults.
    return {
      kind: result.depositFailure.kind ?? "deposit-rejected",
      message: result.depositFailure.reason?.message ?? RAIL_FAILED_MESSAGE,
      ...code(result.depositFailure),
    };
  }
  return { kind: "unknown", message: RAIL_FAILED_MESSAGE };
}

export function railFromSwapStatus<P extends string>(
  provider: P,
  result: SwapStatusResult,
  at: number,
  delayed?: boolean,
): RailReading<P> {
  const stage = stageOf(result);
  return {
    provider,
    status: result.status,
    stage,
    ...(delayed === undefined ? {} : { delayed }),
    ...(stage === "failed" ? { failure: railFailure(result) } : {}),
    updatedAt: at,
  };
}

/** `next` when it fails or moves the stage or status forward; `current` itself when the read
 *  changes nothing, since a stage never moves backwards and an unchanged rail must not look like
 *  a change; else `current` with the latest read's `delayed` and time. */
export function mergeRail<R extends RailLike>(current: R, next: R): R {
  const forward = stageRank(next.stage) - stageRank(current.stage);
  if (next.stage === "failed" || forward > 0) return next;
  const sameDelay = (current.delayed ?? false) === (next.delayed ?? false);
  if (forward === 0) return sameDelay && next.status === current.status ? current : next;
  if (sameDelay) return current;
  const merged: R = { ...current, updatedAt: next.updatedAt };
  if (next.delayed === undefined) delete merged.delayed;
  else merged.delayed = next.delayed;
  return merged;
}
