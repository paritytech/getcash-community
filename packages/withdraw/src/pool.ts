// People's pool math, exactly as its asset conversion pallet computes it, so a swap for an exact
// PAS output can be capped at the CASH it will cost. People exposes no quoting runtime api, so the
// reserves are read from the pool account and these formulas replace the quote.

import { PEOPLE_POOL_FEE_PPM } from "./paseo";

const PPM = 1_000_000n;
const FEE_COMPLEMENT = PPM - PEOPLE_POOL_FEE_PPM;

export interface PoolReserves {
  /** The pool account's CASH, base units. */
  cash: bigint;
  /** The pool account's PAS, planck. */
  pas: bigint;
}

/** The PAS an exact CASH input buys. The pallet's `get_amount_out`. */
export function pasOutFor(cashIn: bigint, reserves: PoolReserves): bigint {
  if (reserves.cash === 0n || reserves.pas === 0n) throw new Error("the People pool is empty");
  const inWithFee = cashIn * FEE_COMPLEMENT;
  return (inWithFee * reserves.pas) / (reserves.cash * PPM + inWithFee);
}

/** The CASH an exact PAS output costs. The pallet's `get_amount_in`, rounded up by one. */
export function cashInFor(pasOut: bigint, reserves: PoolReserves): bigint {
  if (reserves.cash === 0n || reserves.pas === 0n) throw new Error("the People pool is empty");
  if (pasOut >= reserves.pas) throw new Error("the People pool cannot supply that much PAS");
  const numerator = reserves.cash * pasOut * PPM;
  const denominator = (reserves.pas - pasOut) * FEE_COMPLEMENT;
  return numerator / denominator + 1n;
}
