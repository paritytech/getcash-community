// The rail leg: a provider's normalised swap status folded onto the generic stage the shell
// reads, and the merge that keeps that stage monotonic.

import type { SwapStatusResult } from "@getsome/core";
import type { RailState } from "./model";

type RailStage = RailState["stage"];
type RailFailure = NonNullable<RailState["failure"]>;

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
  // The SDK leaves its top-level status on the happy path for these.
  if (result.depositFailure || result.swapEgressFailure || result.fallbackEgress) return "failed";
  switch (result.status) {
    case "waiting":
      return "waiting";
    case "receiving":
      return "received";
    case "swapping":
    case "sending":
      return "processing";
    case "complete":
      return "delivered";
    case "failed":
      return "failed";
  }
}

/** `mapSwapFailure` from `packages/core/src/session.ts`, which core does not export, reduced
 *  to the kind and message. Keep the two in step. */
function railFailure(result: SwapStatusResult): RailFailure {
  if (result.depositFailure) {
    // The rail's own kind and message take precedence over the Chainflip defaults.
    return {
      kind: result.depositFailure.kind ?? "deposit-rejected",
      message:
        result.depositFailure.reason?.message ??
        "Deposit rejected by Chainflip; funds not recoverable",
    };
  }
  if (result.swapEgressFailure) {
    return {
      kind: result.swapEgressFailure.kind ?? "egress-failed",
      message:
        result.swapEgressFailure.reason?.message ??
        "Swap egress failed; funds stuck on Chainflip. Contact support",
    };
  }
  if (result.fallbackEgress) {
    return {
      kind: "fallback-egress",
      message: "Funds routed to a fallback chain. Contact support",
    };
  }
  // Plain SDK failed: Chainflip streams the deposit back to the refund address.
  return {
    kind: "refunded",
    message: "The deposit didn't go through. It is being returned to your recovery address.",
  };
}

export function railFromSwapStatus(
  provider: RailState["provider"],
  result: SwapStatusResult,
  at: number,
  delayed?: boolean,
): RailState {
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

/** `next` when it fails or is at least as far along as `current`; else `current` with the
 *  latest read's `delayed` and time, since a stage never moves backwards. */
export function mergeRail(current: RailState, next: RailState): RailState {
  if (next.stage === "failed" || stageRank(next.stage) >= stageRank(current.stage)) return next;
  const merged: RailState = { ...current, updatedAt: next.updatedAt };
  if (next.delayed === undefined) delete merged.delayed;
  else merged.delayed = next.delayed;
  return merged;
}
