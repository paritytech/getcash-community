import type { FundingProgressView } from "./progress";

export interface ChainflipDepositPendingInput {
  /** A deposit has been seen for the request on screen. */
  fundsSeen: boolean;
  /** The session phase, null before a request exists. */
  phase: string | null;
  /** The foreground progress view's kind, or null when there is no foreground progress yet. */
  progressKind: FundingProgressView["kind"] | null;
}

/**
 * Whether the crypto rail is still waiting for the buyer to send the deposit. A seen deposit ends
 * the wait; the progress view decides when there is one, else the session phase.
 */
export function chainflipDepositPending(input: ChainflipDepositPendingInput): boolean {
  if (input.fundsSeen) return false;
  if (input.progressKind !== null) return input.progressKind === "waiting";
  return input.phase === "awaiting-deposit";
}
