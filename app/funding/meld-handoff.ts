export interface MeldDepositPendingInput {
  /** The native token landed on the burner. */
  fundsSeen: boolean;
  /** The provider approved the payment or the buyer finished in the widget. */
  meldHandedOff: boolean;
  meldStage: "waiting" | "receiving" | "complete" | "failed" | null;
  /** The request on screen still waits for its deposit; false when there is none. */
  awaitingDeposit: boolean;
  /** The rail filed a transaction the buyer has not been seen to pay; see `meldAwaitingBuyerOf`. */
  awaitingBuyer: boolean;
}

/**
 * Whether the Meld rail is still waiting for the buyer to pay. A confirmed, settled, or failed
 * payment ends the wait, and so does a request that left its deposit, unless all that moved it was
 * the rail filing a transaction the buyer is still filling in.
 */
export function meldDepositPending(input: MeldDepositPendingInput): boolean {
  if (input.fundsSeen || input.meldHandedOff || input.meldStage === "complete") return false;
  if (input.meldStage === "failed") return false;
  return input.awaitingDeposit || input.awaitingBuyer;
}
