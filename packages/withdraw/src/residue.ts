// What is left on the burner's Asset Hub account once a sale is over: normally the residue above
// an exact provider payment, or the whole balance when the sale ended without one. It belongs to
// the seller either way, and the journey that brings it home is not this package's to run — it is
// the funding pipeline (`packages/funding`), driven the same way `worker/src/engine.js` already
// drives it for a deposit. This module holds the one thing that journey needs from the withdrawal
// side before it may even look at the burner: the floor below which trying costs the seller more
// than it recovers.
//
// THE FLOOR IS A GUESS, AND SAYS SO. Returning the residue spends one Asset Hub extrinsic (the
// funding program itself: withdraw, pay its own fees, exchange, teleport, all in one call) plus
// whatever the destination's execution fee takes in the underlying before the claim can register
// it with the host. None of that is measured here — the real cost wants a live estimate the way
// `assetHubPaymentOverhead` prices the provider payment, and nothing in this package or the
// worker prices a funding program's fee ahead of building one. Until that estimate exists, the
// floor is a flat multiple of `DEFAULT_KEEP_NATIVE_FOR_FEES`, the funding pipeline's own sizing
// figure for what its fees are expected to cost (see `packages/funding/src/pipeline.ts`), with
// enough headroom that a residue clearing it is not mostly consumed proving it existed. A residue
// under the floor is left exactly where it is — the worker records that plainly rather than
// spending the seller's PAS to chase it.
//
// "LEFT ALONE" IS A CURRENT FACT, NOT A PROMISE. The worker treats a `left-below-floor` decision
// as permanent because nothing today can grow a balance this function has already judged too
// small — the account gets no further credits once the sale is over. If that ever stops being
// true (a fee refund, a stray transfer, a floor that itself gets cheaper to clear), revisiting a
// left-behind residue is a worker-side change, not one this function needs to anticipate; this
// function only ever answers the question honestly for the balance it is given.

/** DEFAULT_KEEP_NATIVE_FOR_FEES from `@getsome/funding`, restated rather than imported: this
 *  package does not depend on `@getsome/funding` (the worker is the one place that wires the two
 *  together), and the figure is a sizing constant, not a live read, so restating it here does not
 *  risk the two drifting apart in a way that matters — both are guesses at the same order of
 *  magnitude, not a computation either side must reproduce exactly. */
const FUNDING_PROGRAM_FEE_GUESS_PLANCK = 200_000_000n; // 0.02 PAS at 10 decimals

/** How far above the fee guess a residue must sit before returning it is worth doing. Five times
 *  the guess: comfortably clear of both the funding program's own fees and the People-side
 *  destination fee the claim consumes out of what lands, without being so high that an ordinary
 *  residue — the sale's quantisation and drift buffer, not a windfall — routinely misses it. */
const RETURN_FLOOR_HEADROOM = 5n;

/** Below this, on Asset Hub, a return is not attempted: the funding program's own fees plus the
 *  People-side fee the claim consumes would eat a large share of it, or all of it. Conservative by
 *  construction (see the header) and wants replacing with a live fee estimate once one exists;
 *  until then it errs toward leaving small residues alone over spending them to prove a point. */
export const RETURN_FLOOR_PLANCK = FUNDING_PROGRAM_FEE_GUESS_PLANCK * RETURN_FLOOR_HEADROOM; // 0.1 PAS

/** Whether a native balance on the burner's Asset Hub account clears the floor above which a
 *  return is worth attempting. `nativePlanck` is the account's free balance, not a quote or an
 *  estimate — the same kind of real reading `payProvider` takes before it decides to pay. */
export function residueWorthReturning(nativePlanck: bigint): boolean {
  return nativePlanck >= RETURN_FLOOR_PLANCK;
}
