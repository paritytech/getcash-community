export interface ChainflipDepositPendingInput {
  /** A deposit has been seen for the request on screen. */
  fundsSeen: boolean;
  /** The request on screen still waits for its deposit; false when there is none. */
  awaitingDeposit: boolean;
}

/**
 * Whether the crypto rail is still waiting for the buyer to send the deposit. A seen deposit ends
 * the wait, and so does a request that left its deposit.
 */
export function chainflipDepositPending(input: ChainflipDepositPendingInput): boolean {
  return !input.fundsSeen && input.awaitingDeposit;
}
