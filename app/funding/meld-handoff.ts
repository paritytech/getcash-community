import type { FundingProgressView } from "./progress";

export interface MeldDepositPendingInput {
  /** The native token landed on the burner. */
  fundsSeen: boolean;
  /** The provider approved the payment or the buyer finished in the widget. */
  meldHandedOff: boolean;
  meldStage: "waiting" | "receiving" | "complete" | "failed" | null;
  /** The session phase, null before a request exists. */
  phase: string | null;
  /** The foreground progress view's kind, or null when there is no foreground progress yet. */
  progressKind: FundingProgressView["kind"] | null;
}

/**
 * Whether the Meld rail is still waiting for the buyer to pay. A confirmed, settled, or failed
 * payment ends the wait; the progress view decides when there is one, else the session phase.
 */
export function meldDepositPending(input: MeldDepositPendingInput): boolean {
  if (input.fundsSeen || input.meldHandedOff || input.meldStage === "complete") return false;
  if (input.meldStage === "failed") return false;
  if (input.progressKind !== null) return input.progressKind === "waiting";
  return input.phase === "awaiting-deposit";
}
