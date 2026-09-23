// Chooses the exact figure the off-ramp commits to paying the provider.
//
// A fiat provider is told a crypto amount N before the user starts KYC and expects exactly N to
// arrive afterwards. Between the two, minutes pass and the Asset Hub pool moves. N therefore has
// to be a figure the sale will still cover at the end of that window, which means committing to
// less than the pool quotes now and keeping the difference as a buffer.
//
// WHAT THE BUFFER IS FOR, AND WHAT IT IS NOT FOR. `quote_price_exact_tokens_for_tokens` already
// prices our own trade at its exact size, price impact included, so there is nothing to haircut
// for the size of the sale itself. The buffer covers two things and no others: counterparty
// volume moving the pool while the user does KYC, and the Asset Hub transfer fee plus the
// existential deposit, which have to survive on the burner after the payment leaves.
//
// THE DRIFT IS AN ABSOLUTE VOLUME, AND IT HAS TO BE. Counterparty flow is a fact about the
// market, not about our pool: roughly the same CASH trades against us in ten minutes whether the
// pool holding it is deep or thin. What that flow COSTS us is entirely a fact about the pool, and
// converting the one into the other is exactly what the reserve probe is for — it is load-bearing
// here, not decoration.
//
// An earlier draft expressed the drift as a fraction of the reserve. That is a trap: being
// depth-normalised by construction, a fixed fraction D produces a near-constant price move of
// about 2·D on EVERY pool (analytically 1 - 2D for a sale small against the pool, tending to
// 1 - 1.5D as the sale approaches the pool's size). It is a flat price haircut wearing a volume's
// clothes, it argues against its own parameterisation, and it errs in the worst possible
// direction — under-protecting thin pools and over-paying on deep ones, with the error growing
// precisely as the pool shrinks, which is the regime where a missed commitment is most likely.
//
// So the tunable is a flow per unit time times the window it has to act over, in CASH. The
// fraction-of-reserve form survives only as an upper CAP: when the flow we expect is a large
// share of the whole pool, no buffer is honest, and the right answer is to refuse the commitment
// rather than to invent a number. A thin pool degrades to "unfundable", not to nonsense.
//
// GETTING THE RESERVES WITHOUT PINNING AN ADDRESS. The pallet derives a pool's account from its
// asset pair, so the address could be constanted — and would go stale the day the pool is
// redeployed or the pair is re-keyed, silently, with the buffer still looking plausible. Instead
// the reserves are recovered from two quotes at x and 2x, which the chain answers for whatever
// pool is live. The algebra is in `solveReserves`.
//
// N IS QUANTISED DOWN. A live probe of the provider showed it holding the committed amount at 8
// decimal places for a 10-decimal asset (16.76363636). A figure with more precision than the
// provider can store is a figure our exact transfer will not match, and a mismatched deposit is a
// stuck payout. So N is rounded to the provider's precision, and rounded DOWN: rounding up would
// raise the floor the sale has to clear, which is the one direction that can turn a fundable
// commitment into an unfundable one.

import type { AssetHubApi } from "./fees";
import { pasOutFor, type PoolReserves } from "./pool";
import { PEOPLE_NATIVE } from "./paseo";
import { CASH_ON_ASSET_HUB } from "./program";

const PPM = 1_000_000n;

/**
 * Adverse counterparty flow assumed against us, CASH base units per minute.
 *
 * THIS IS A PLACEHOLDER AND WANTS PRODUCTION DATA: the realised per-minute sell-side volume on
 * the live pool, at a high percentile rather than a mean. The figure here is four million units
 * a minute, which against the reserves seen when this was written is about one percent of the
 * pool over a ten-minute window — deliberately pessimistic for a young pool with little flow.
 */
export const DEFAULT_COUNTERPARTY_CASH_PER_MINUTE = 4_000_000n;

/**
 * How long the user is assumed to spend in KYC, minutes.
 *
 * THIS WANTS PRODUCTION DATA too: the observed completion time at a high percentile, not the
 * median, since the commitment has to survive the slow users and not the typical one.
 */
export const DEFAULT_KYC_WINDOW_MINUTES = 10;

/**
 * The most of the pool's own CASH reserve the assumed flow may be before the pool is judged too
 * thin to commit against at all, parts per million. Ten percent: past that the constant-product
 * curve has moved so far that the "buffer" is really a guess about a market we cannot price, and
 * refusing is the honest answer.
 */
export const MAX_DRIFT_PPM_OF_RESERVE = 100_000n;

/** Decimals the provider stores the committed amount at, from the live probe. */
export const DEFAULT_PROVIDER_DECIMALS = 8;

/** Decimals of the relay native the provider is paid in: 10 for both PAS and DOT. */
export const RELAY_NATIVE_DECIMALS = 10;

/** The pool moved, or is too thin, for any payable commitment to be sized. */
export class CommitmentTooSmallError extends Error {
  constructor(
    readonly adverseOut: bigint,
    readonly overhead: bigint,
  ) {
    super(
      `withdraw commitment: the sale would return ${adverseOut} after drift, which does not cover the ${overhead} the payment needs`,
    );
    this.name = "CommitmentTooSmallError";
  }
}

/** The pool is too thin for the flow we expect to have to survive, so no commitment can honestly
 *  be made against it. Refusing beats sizing a buffer from a curve this far from where it was
 *  measured. */
export class PoolTooThinError extends Error {
  constructor(
    readonly driftCash: bigint,
    readonly cap: bigint,
  ) {
    super(
      `withdraw commitment: the window's ${driftCash} CASH of assumed flow is above the ${cap} this pool can absorb`,
    );
    this.name = "PoolTooThinError";
  }
}

/**
 * The pool's reserves, recovered from two quotes instead of a pinned pool account.
 *
 * With M = 1e6, F = M - feePpm, D = cash·M and u = x·F, the pallet's `get_amount_out` is
 *
 *     q(x) = u·pas / (D + u)
 *
 * so for the two probes x and 2x:
 *
 *     q1·(D + u)  = u·pas        =>  q1·D = u·(pas - q1)          (1)
 *     q2·(D + 2u) = 2u·pas       =>  q2·D = 2u·(pas - q2)         (2)
 *
 * Dividing (2) by (1) removes both D and u:
 *
 *     q2/q1 = 2·(pas - q2)/(pas - q1)
 *     q2·pas - q1·q2 = 2·q1·pas - 2·q1·q2
 *     pas·(q2 - 2·q1) = -q1·q2
 *     pas = q1·q2 / (2·q1 - q2)                                   (3)
 *
 * and substituting back into (1):
 *
 *     cash = x·F·(pas - q1) / (q1·M)                              (4)
 *
 * 2·q1 - q2 is strictly positive because the curve is concave: doubling the input buys less than
 * twice the output. Note that (3) has no fee in it — only the CASH side (4) does — so a mis-set
 * fee moves the recovered depth by at most the fee itself.
 *
 * The recovered reserves are approximate to a few units, since the quotes are floored, which is
 * far below the resolution the buffer is sized at.
 *
 * Returns null, rather than throwing, when the two quotes are indistinguishable from a straight
 * line — 2·q1 - q2 collapsing to zero or below. The bend is about 2·q1·x/cash before the quote's
 * own flooring, so a pool deep enough relative to the probe loses it entirely. That is not a
 * broken pool, it is the safest kind there is, and throwing on the deepest pools would be
 * exactly the wrong failure mode; the caller escalates the probe instead.
 *
 * Both quotes must come from the SAME block. The bend is a small difference of two large
 * numbers, so a pool that moves between the two reads does not merely add noise: it can scale
 * the recovered depth by a large factor, or invert the pair entirely.
 */
export function solveReserves(
  probeCash: bigint,
  quoteAtX: bigint,
  quoteAt2X: bigint,
  feePpm: bigint,
): PoolReserves | null {
  if (probeCash <= 0n) throw new Error("withdraw commitment: the reserve probe needs a size");
  // Doubling the input must buy more, and less than twice as much. Anything else is not this
  // curve at all, and no probe size will make it one.
  if (quoteAtX <= 0n || quoteAt2X <= quoteAtX) {
    throw new Error(
      `withdraw commitment: quotes ${quoteAtX} and ${quoteAt2X} are not a constant-product pair`,
    );
  }
  const bend = 2n * quoteAtX - quoteAt2X;
  if (bend <= 0n) return null;
  const pas = (quoteAtX * quoteAt2X) / bend;
  const cash = (probeCash * (PPM - feePpm) * (pas - quoteAtX)) / (quoteAtX * PPM);
  return cash > 0n ? { cash, pas } : null;
}

/** Probe sizes to try, as multiples of the sale. A pool with no measurable bend at the sale's
 *  own size is probed harder before it is called bottomless. */
const PROBE_ESCALATION = [1n, 100n, 10_000n, 1_000_000n];

/**
 * Reads Asset Hub's effective reserves for the CASH/native pair by probing its quoter at `x` and
 * `2x`. No pool account is named, so a redeployed pool answers as well as the current one.
 *
 * `atBlock` pins both quotes of a pair to one block hash and should always be supplied: the two
 * reads are separate runtime calls, and a pool that moves between them corrupts the solve rather
 * than merely blurring it. Without it the pair can also come back inconsistent, which is treated
 * as a probe to skip rather than a verdict on the pool.
 */
export async function probeAssetHubReserves(
  assetHubApi: AssetHubApi,
  probeCash: bigint,
  feePpm: bigint,
  atBlock?: string,
): Promise<PoolReserves> {
  const quote = (cashIn: bigint) =>
    assetHubApi.apis.AssetConversionApi.quote_price_exact_tokens_for_tokens(
      CASH_ON_ASSET_HUB as never,
      PEOPLE_NATIVE as never,
      cashIn,
      true,
      ...((atBlock === undefined ? [] : [{ at: atBlock }]) as []),
    );
  let first: bigint | undefined;
  let sawStraightLine = false;
  let inconsistent: unknown = null;
  for (const multiple of PROBE_ESCALATION) {
    const size = probeCash * multiple;
    const [atX, at2X] = await Promise.all([quote(size), quote(2n * size)]);
    // A probe the pool cannot fill says nothing about the pool; the next size up is the likely
    // cause, so step past it rather than end the escalation on it.
    if (atX === undefined || at2X === undefined) continue;
    if (multiple === 1n) first = atX;
    try {
      const solved = solveReserves(size, atX, at2X, feePpm);
      if (solved !== null) return solved;
      sawStraightLine = true;
    } catch (error) {
      // Not a constant-product pair. Most likely the two reads straddled a change; try another
      // size before concluding anything, and report it if every size says the same.
      inconsistent = error;
    }
  }
  if (first === undefined) {
    throw new Error("withdraw commitment: Asset Hub cannot quote the reserve probe");
  }
  // Every size that answered was inconsistent, and none was merely flat: that is a quoter this
  // math does not describe, not a deep pool.
  if (!sawStraightLine && inconsistent !== null) throw inconsistent;
  // Still a straight line a million times over: the pool is bottomless as far as this sale is
  // concerned. Stand in a pool deep enough to price the same and to absorb any drift without
  // moving, rather than refuse a pool whose only fault is being enormous.
  // Sized so the stand-in reprices the observed quote rather than the ratio behind it: with
  // cash >> x the curve is q = x·F·pas/(cash·M), so pas = q1·cash·M/(x·F) reproduces q1 and the
  // pool's fee is not charged a second time.
  const cash = probeCash * BOTTOMLESS_MULTIPLE;
  return { cash, pas: (first * cash * PPM) / (probeCash * (PPM - feePpm)) };
}

/** How much deeper than the sale a pool with no measurable bend is treated as being. Large
 *  enough that the drift shifts the price by less than a rounding error. */
const BOTTOMLESS_MULTIPLE = 1_000_000_000n;

export interface SizeCommitmentInput {
  /** The CASH the XCM will sell on Asset Hub. */
  cashToSell: bigint;
  /** Asset Hub's reserves for the pair, from `probeAssetHubReserves`. */
  reserves: PoolReserves;
  /** Asset Hub's LP fee, parts per million. Not assumed equal to People's. */
  poolFeePpm: bigint;
  /** Asset Hub's own quote for `cashToSell`; the commitment is never above it. */
  quotedOut: bigint;
  /** The Asset Hub transfer's fee, planck, estimated on the real call. */
  transferFeePlanck: bigint;
  /** Asset Hub's existential deposit: the burner must survive the payment, because a later step
   *  returns the residue from that same account. */
  existentialDeposit: bigint;
  /** Adverse counterparty flow, CASH base units per minute. A fact about the market. */
  counterpartyCashPerMinute?: bigint;
  /** How long the flow has to act: the KYC window, minutes. */
  kycWindowMinutes?: number;
  /** The share of the CASH reserve the window's flow may reach before the pool is refused. */
  maxDriftPpmOfReserve?: bigint;
  /** Decimals the provider can store the committed figure at. */
  providerDecimals?: number;
  /** Decimals of the native being committed. */
  nativeDecimals?: number;
}

export interface Commitment {
  /** The exact figure to give the provider and to transfer, planck, quantised. */
  planck: bigint;
  /** What the sale returns after the adverse shift, before overhead and quantisation. */
  adverseOut: bigint;
  /** What Asset Hub quotes at the reserves as they stand now. */
  quotedOut: bigint;
  /** The adverse counterparty volume assumed, CASH units. */
  driftCash: bigint;
  /** The transfer fee and existential deposit held back out of the sale. */
  overhead: bigint;
}

/** The exact amount to commit to the provider: what the sale still returns after the window's
 *  worth of adverse volume, less the fee and deposit the payment must leave behind, quantised
 *  down to the precision the provider can hold. */
export function sizeCommitment(input: SizeCommitmentInput): Commitment {
  const perMinute = input.counterpartyCashPerMinute ?? DEFAULT_COUNTERPARTY_CASH_PER_MINUTE;
  const windowMinutes = input.kycWindowMinutes ?? DEFAULT_KYC_WINDOW_MINUTES;
  const maxDriftPpm = input.maxDriftPpmOfReserve ?? MAX_DRIFT_PPM_OF_RESERVE;
  const providerDecimals = input.providerDecimals ?? DEFAULT_PROVIDER_DECIMALS;
  const nativeDecimals = input.nativeDecimals ?? RELAY_NATIVE_DECIMALS;
  if (providerDecimals > nativeDecimals) {
    throw new Error("withdraw commitment: the provider cannot hold more decimals than the asset");
  }

  // The flow we have to survive, in CASH: a market rate times the window it acts over. What it
  // costs is then read off this pool's own curve, which is the probe's real job.
  const driftCash = perMinute * BigInt(Math.max(0, Math.round(windowMinutes)));
  const cap = (input.reserves.cash * maxDriftPpm) / PPM;
  // Beyond the cap the shift takes the curve so far from where it was measured that the number
  // coming out would be a guess dressed as a buffer. Refuse the pool instead.
  if (driftCash > cap) throw new PoolTooThinError(driftCash, cap);

  // Third parties sell that much CASH into the pool ahead of us. The whole input joins the CASH
  // reserve, fee included, and the PAS it buys leaves; our sale is then priced on what is left.
  const shifted: PoolReserves = {
    cash: input.reserves.cash + driftCash,
    pas: input.reserves.pas - pasOutFor(driftCash, input.reserves, input.poolFeePpm),
  };
  const adverseOut = pasOutFor(input.cashToSell, shifted, input.poolFeePpm);

  // The payment is a transfer out of the burner: its fee and the deposit that keeps the account
  // alive both have to come out of the same proceeds.
  const overhead = input.transferFeePlanck + input.existentialDeposit;
  if (adverseOut <= overhead) throw new CommitmentTooSmallError(adverseOut, overhead);
  const payable = adverseOut - overhead;

  // Never commit above what the pool will pay right now, LESS the same overhead: a commitment
  // equal to the live quote is unfundable the instant it is made, since the floor under the sale
  // is the commitment plus that overhead. Unreachable while the drift is positive, and kept
  // because the one direction it could fail in is a stuck payout.
  const liveCeiling = input.quotedOut > overhead ? input.quotedOut - overhead : 0n;
  const capped = payable < liveCeiling ? payable : liveCeiling;

  // Down to the provider's precision. Down, never up: up would raise the floor the sale has to
  // clear and could make a commitment we just proved fundable unfundable.
  const step = 10n ** BigInt(nativeDecimals - providerDecimals);
  const planck = (capped / step) * step;
  if (planck <= 0n) throw new CommitmentTooSmallError(adverseOut, overhead);

  return { planck, adverseOut, quotedOut: input.quotedOut, driftCash, overhead };
}
