// Constant-product-with-fee pool math, exactly as the asset conversion pallet computes it, so a
// swap for an exact output can be capped at what it will cost. People exposes no quoting runtime
// api, so the reserves are read from the pool account and these formulas replace the quote.
//
// The fee is a parameter, defaulted to People's. Asset Hub runs the same pallet but is free to
// configure a different LP fee, and the off-ramp sizes a commitment against Asset Hub's pool; a
// hardcoded fee there would silently mis-price it.

import { PEOPLE_POOL_FEE_PPM } from "./paseo";

const PPM = 1_000_000n;

export interface PoolReserves {
  /** The pool account's CASH, base units. */
  cash: bigint;
  /** The pool account's PAS, planck. */
  pas: bigint;
}

/** The PAS an exact CASH input buys. The pallet's `get_amount_out`. */
export function pasOutFor(
  cashIn: bigint,
  reserves: PoolReserves,
  feePpm: bigint = PEOPLE_POOL_FEE_PPM,
): bigint {
  if (reserves.cash === 0n || reserves.pas === 0n) throw new Error("the People pool is empty");
  const inWithFee = cashIn * (PPM - feePpm);
  return (inWithFee * reserves.pas) / (reserves.cash * PPM + inWithFee);
}

/** The CASH an exact PAS output costs. The pallet's `get_amount_in`, rounded up by one. */
export function cashInFor(
  pasOut: bigint,
  reserves: PoolReserves,
  feePpm: bigint = PEOPLE_POOL_FEE_PPM,
): bigint {
  if (reserves.cash === 0n || reserves.pas === 0n) throw new Error("the People pool is empty");
  if (pasOut >= reserves.pas) throw new Error("the People pool cannot supply that much PAS");
  const numerator = reserves.cash * pasOut * PPM;
  const denominator = (reserves.pas - pasOut) * (PPM - feePpm);
  return numerator / denominator + 1n;
}
