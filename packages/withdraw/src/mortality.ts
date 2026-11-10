// How long the key's submits stay valid, shared by the exact payment and the PSM tier's exit on
// Asset Hub and the XCM on People: each is signed under this period, so one whose answer was lost
// or whose block was dropped is settled from the chain, and called dead once finality is past its
// mortality.

/** Blocks a submit stays valid after the block it is anchored at, on the chain it is sent to.
 *  Signed in rather than left to papi's default, since `exactPaymentLanded`, the exit's settling
 *  and `xcmNeverLands` count on it to call an unlanded attempt dead. */
export const PAY_MORTAL_PERIOD = 64;

/** Whether an attempt anchored at block `anchor` can still land with the finalized chain at
 *  `finalized`: it is valid for PAY_MORTAL_PERIOD blocks past its anchor, so once finality is
 *  beyond them with the key's nonce unmoved, it never will. */
export const mayStillLand = (anchor: number, finalized: number): boolean =>
  finalized <= anchor + PAY_MORTAL_PERIOD;
