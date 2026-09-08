// Swap-status normalization: callers see mapped states, never raw Chainflip ones.

import type {
  ChainflipFailureInfo,
  EgressInfo,
  SwapProgress,
  SwapStatusResult,
} from "@getsome/core";

export const CHAINFLIP_PROGRESS_STATUSES = [
  "waiting",
  "receiving",
  "swapping",
  "sending",
  "complete",
] as const satisfies readonly SwapProgress[];

export type ChainflipProgressStatus = (typeof CHAINFLIP_PROGRESS_STATUSES)[number];

export interface StatusBackend {
  getStatusV2(args: { id: string }): Promise<unknown>;
}

/**
 * Fetch and normalize a swap's status by deposit channel id (e.g. "123-Bitcoin-45").
 * SDK states: WAITING, RECEIVING, SWAPPING, SENDING, SENT, COMPLETED, FAILED.
 */
export async function getSwapStatus(
  backend: StatusBackend,
  depositChannelId: string,
): Promise<SwapStatusResult> {
  const result = await backend.getStatusV2({ id: depositChannelId });

  const r = result as {
    state?: string;
    deposit?: { failure?: ChainflipFailureInfo };
    swapEgress?: EgressInfo & { failure?: ChainflipFailureInfo };
    fallbackEgress?: EgressInfo;
    refundEgress?: EgressInfo;
  };

  const base: Omit<SwapStatusResult, "status"> = {
    // The successful egress lifecycle (amount/txRef/witnessedAt): deliver-mode's receipt source.
    egress: r.swapEgress
      ? {
          amount: r.swapEgress.amount,
          scheduledAt: r.swapEgress.scheduledAt,
          txRef: r.swapEgress.txRef,
          witnessedAt: r.swapEgress.witnessedAt,
        }
      : undefined,
    // Deposit rejected by Chainflip (BelowMinimumDeposit, NotEnoughToPayFees, ...); funds are not
    // recoverable.
    depositFailure: r.deposit?.failure,
    // Swap egress (DOT to Asset Hub) failed.
    swapEgressFailure: r.swapEgress?.failure,
    // Chainflip routed funds to a fallback chain; funds are not on Asset Hub.
    fallbackEgress: r.fallbackEgress,
    // Refund egress states once status === 'failed' (slippage-violation path).
    refundEgress: r.refundEgress,
    raw: result,
  };

  if (r.state === "WAITING") return { status: "waiting", ...base };
  if (r.state === "RECEIVING") return { status: "receiving", ...base };
  if (r.state === "SWAPPING") return { status: "swapping", ...base };
  if (r.state === "SENDING" || r.state === "SENT") return { status: "sending", ...base };
  if (r.state === "COMPLETED") return { status: "complete", ...base };
  if (r.state === "FAILED") return { status: "failed", ...base };

  return { status: "waiting", ...base };
}

/**
 * True when depositFailure, swapEgressFailure or fallbackEgress is present; the SDK leaves the
 * top-level state on its happy-path value for these.
 */
export function isImplicitFailure(result: SwapStatusResult): boolean {
  return !!result.depositFailure || !!result.swapEgressFailure || !!result.fallbackEgress;
}
