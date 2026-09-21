// The commitment sizing against pools of very different depth: that the two-point probe recovers
// reserves the chain never told us, that the buffer means the same thing on every pool, that the
// figure is always payable and always at a precision the provider can hold.

import { describe, expect, it } from "vitest";
import {
  CommitmentTooSmallError,
  DEFAULT_COUNTERPARTY_CASH_PER_MINUTE,
  DEFAULT_KYC_WINDOW_MINUTES,
  MAX_DRIFT_PPM_OF_RESERVE,
  PoolTooThinError,
  probeAssetHubReserves,
  sizeCommitment,
  solveReserves,
} from "./commitment";
import { ASSET_HUB_POOL_FEE_PPM } from "./paseo";
import { pasOutFor, type PoolReserves } from "./pool";

const FEE = ASSET_HUB_POOL_FEE_PPM;
/** The CASH one withdrawal sells, as the live probes saw it. */
const SALE = 20_999_683n;
/** Asset Hub's transfer fee and existential deposit, planck. */
const TRANSFER_FEE = 15_000_000n;
const ED = 1_000_000_000n;

/** The pool People held when this was written, and two thinner ones at the same price. */
const DEEP: PoolReserves = { cash: 4_004_853_413n, pas: 9_987_917_550_000n };
const THIN: PoolReserves = { cash: 1_000_000_000n, pas: 2_500_000_000_000n };
const THINNEST: PoolReserves = { cash: 500_000_000n, pas: 1_250_000_000_000n };
/** A flow small enough that all three pools accept it, for comparing what it costs each. */
const MODEST_FLOW = { counterpartyCashPerMinute: 4_000_000n, kycWindowMinutes: 10 };

const quoteOf = (reserves: PoolReserves) => (cashIn: bigint) => pasOutFor(cashIn, reserves, FEE);

const sized = (reserves: PoolReserves, over: Partial<Parameters<typeof sizeCommitment>[0]> = {}) =>
  sizeCommitment({
    cashToSell: SALE,
    reserves,
    poolFeePpm: FEE,
    quotedOut: quoteOf(reserves)(SALE),
    transferFeePlanck: TRANSFER_FEE,
    existentialDeposit: ED,
    ...MODEST_FLOW,
    ...over,
  });

/** How far below the live quote the commitment sits, in percent. */
const bufferPct = (reserves: PoolReserves, over = {}) => {
  const c = sized(reserves, over);
  return (Number(c.quotedOut - c.adverseOut) / Number(c.quotedOut)) * 100;
};

describe("the two-point reserve probe", () => {
  it("recovers reserves the chain never reports, from quotes alone", () => {
    for (const reserves of [DEEP, THIN, THINNEST]) {
      const quote = quoteOf(reserves);
      // These pools all bend at the sale's size, so the solve has an answer.
      const solved = solveReserves(SALE, quote(SALE), quote(2n * SALE), FEE)!;
      // The quotes are floored, so the solve lands within a few parts per billion, not exactly.
      const off = (a: bigint, b: bigint) => Math.abs(Number(a - b) / Number(b));
      expect(off(solved.cash, reserves.cash)).toBeLessThan(1e-6);
      expect(off(solved.pas, reserves.pas)).toBeLessThan(1e-6);
    }
  });

  it("prices the same as the pool it recovered", () => {
    const quote = quoteOf(DEEP);
    const solved = solveReserves(SALE, quote(SALE), quote(2n * SALE), FEE)!;
    const off = Number(pasOutFor(SALE, solved, FEE) - quote(SALE)) / Number(quote(SALE));
    expect(Math.abs(off)).toBeLessThan(1e-6);
  });

  it("probes Asset Hub at x and 2x and names no pool account", async () => {
    const asked: bigint[] = [];
    const quote = quoteOf(THIN);
    const assetHubApi = {
      apis: {
        AssetConversionApi: {
          quote_price_exact_tokens_for_tokens: async (_a: unknown, _b: unknown, cashIn: bigint) => {
            asked.push(cashIn);
            return quote(cashIn);
          },
        },
      },
    };
    const solved = await probeAssetHubReserves(assetHubApi as never, SALE, FEE);
    expect(asked.sort()).toEqual([SALE, 2n * SALE]);
    expect(Math.abs(Number(solved.cash - THIN.cash) / Number(THIN.cash))).toBeLessThan(1e-6);
  });

  it("reads a pool with no measurable bend as bottomless, and refuses only real nonsense", () => {
    // A quoter that looks linear at this probe size is not a broken pool, it is one far deeper
    // than the probe. Throwing there would fail on the safest pools there are, so it answers
    // null and the caller probes harder.
    expect(solveReserves(SALE, 100n, 200n, FEE)).toBeNull();
    // Buying less by spending more is not this curve, and no probe size will make it one.
    expect(() => solveReserves(SALE, 100n, 90n, FEE)).toThrow(/constant-product/);
  });

  it("escalates the probe rather than fail on a pool too deep to bend at the sale's size", async () => {
    // A chain whose quote is indistinguishable from a straight line until the probe is large
    // enough to bend the curve past the floor of its own arithmetic. That is a very deep pool,
    // the safest case there is, and the probe must climb rather than give up on it.
    const BENDS_ABOVE = SALE * 50n;
    const RATE = 3_780n;
    const curve: PoolReserves = { cash: SALE * 1_000n, pas: SALE * 1_000n * RATE };
    const sizes: bigint[] = [];
    const assetHubApi = {
      apis: {
        AssetConversionApi: {
          quote_price_exact_tokens_for_tokens: async (_a: unknown, _b: unknown, cashIn: bigint) => {
            sizes.push(cashIn);
            return cashIn <= BENDS_ABOVE ? cashIn * RATE : pasOutFor(cashIn, curve, FEE);
          },
        },
      },
    };
    // Flat at the sale's own size: nothing to solve, and null rather than a throw.
    expect(solveReserves(SALE, SALE * RATE, 2n * SALE * RATE, FEE)).toBeNull();
    const solved = await probeAssetHubReserves(assetHubApi as never, SALE, FEE);
    expect(sizes.length).toBeGreaterThan(2);
    expect(solved.cash).toBeGreaterThan(0n);
    // And a pool that is linear at every size it will answer for is treated as bottomless:
    // deep enough that the drift moves the price by less than a unit.
    const linear = {
      apis: {
        AssetConversionApi: {
          quote_price_exact_tokens_for_tokens: async (_a: unknown, _b: unknown, cashIn: bigint) =>
            cashIn * RATE,
        },
      },
    };
    const bottomless = await probeAssetHubReserves(linear as never, SALE, FEE);
    expect(bottomless.cash).toBeGreaterThan(SALE * 1_000_000n);
    const c = sizeCommitment({
      cashToSell: SALE,
      reserves: bottomless,
      poolFeePpm: FEE,
      quotedOut: SALE * RATE,
      transferFeePlanck: TRANSFER_FEE,
      existentialDeposit: ED,
      ...MODEST_FLOW,
    });
    // Essentially no buffer: there is nothing for the flow to move.
    expect(Number(c.quotedOut - c.adverseOut) / Number(c.quotedOut)).toBeLessThan(0.001);
  });
});

describe("sizeCommitment", () => {
  it("never commits above what the pool quotes now", () => {
    for (const reserves of [DEEP, THIN, THINNEST]) {
      const c = sized(reserves);
      expect(c.adverseOut).toBeLessThan(c.quotedOut);
      expect(c.planck).toBeLessThan(c.quotedOut);
      // And never above what the sale would still return after the drift, less the overhead.
      expect(c.planck).toBeLessThanOrEqual(c.adverseOut - c.overhead);
    }
  });

  it("charges the same counterparty flow to each pool at what that pool's own curve says", () => {
    // THE property of the model. One flow, a fact about the market, costs a deep pool almost
    // nothing and a thin pool a great deal, and the buffer grows monotonically as depth falls.
    // A fraction-of-reserve drift produced a near-constant haircut here and protected exactly
    // the wrong pools.
    const deep = bufferPct(DEEP);
    const thin = bufferPct(THIN);
    const thinnest = bufferPct(THINNEST);
    expect(deep).toBeLessThan(thin);
    expect(thin).toBeLessThan(thinnest);
    expect(thinnest).toBeGreaterThan(4 * deep);
    // And the drift itself is the flow, unchanged by whose pool it lands in.
    expect(sized(DEEP).driftCash).toBe(sized(THINNEST).driftCash);
  });

  it("derives the drift from a rate and a window", () => {
    const c = sized(DEEP, { counterpartyCashPerMinute: 3_000n, kycWindowMinutes: 7 });
    expect(c.driftCash).toBe(21_000n);
    // Defaults are the shipped rate over the shipped window.
    expect(sized(DEEP, {}).driftCash).toBe(MODEST_FLOW.counterpartyCashPerMinute * 10n);
    expect(DEFAULT_COUNTERPARTY_CASH_PER_MINUTE * BigInt(DEFAULT_KYC_WINDOW_MINUTES)).toBe(
      40_000_000n,
    );
  });

  it("widens the buffer as the flow or the window it must survive widens", () => {
    const small = sized(DEEP, { kycWindowMinutes: 1 });
    const long = sized(DEEP, { kycWindowMinutes: 60 });
    const fast = sized(DEEP, { counterpartyCashPerMinute: 40_000_000n });
    expect(long.driftCash).toBeGreaterThan(small.driftCash);
    expect(long.adverseOut).toBeLessThan(small.adverseOut);
    expect(long.planck).toBeLessThan(small.planck);
    expect(fast.planck).toBeLessThan(small.planck);
  });

  it("refuses a pool too thin to absorb the flow, rather than inventing a buffer", () => {
    // The fraction-of-reserve form survives only as this cap. Past it the shift takes the curve
    // so far from where it was measured that any number out of it is a guess.
    const tiny: PoolReserves = { cash: 20_000_000n, pas: 50_000_000_000n };
    const cap = (tiny.cash * MAX_DRIFT_PPM_OF_RESERVE) / 1_000_000n;
    expect(MODEST_FLOW.counterpartyCashPerMinute * 10n).toBeGreaterThan(cap);
    expect(() => sized(tiny)).toThrow(PoolTooThinError);
    // The same pool with a flow it can absorb is sized normally.
    expect(sized(tiny, { counterpartyCashPerMinute: 100_000n }).planck).toBeGreaterThan(0n);
  });

  it("holds back the transfer fee and the deposit so the payment can actually be made", () => {
    const c = sized(DEEP);
    expect(c.overhead).toBe(TRANSFER_FEE + ED);
    expect(c.planck + c.overhead).toBeLessThanOrEqual(c.adverseOut);
  });

  it("quantises down to the precision the provider can store, never up", () => {
    // 8 decimals for a 10-decimal asset: the figure must be a multiple of 100 planck.
    const c = sized(DEEP);
    expect(c.planck % 100n).toBe(0n);
    expect(c.planck).toBeLessThanOrEqual(c.adverseOut - c.overhead);
    // Rounding down only ever loses less than one of the provider's units.
    expect(c.adverseOut - c.overhead - c.planck).toBeLessThan(100n);
    // A coarser provider quantises coarser, and still downwards.
    const coarse = sized(DEEP, { providerDecimals: 2 });
    expect(coarse.planck % 100_000_000n).toBe(0n);
    expect(coarse.planck).toBeLessThanOrEqual(c.planck);
  });

  it("never commits the whole live quote, so the floor it creates is always reachable", () => {
    // The cap is the live quote LESS the overhead: a commitment equal to the quote would be
    // unfundable the moment it was made, since the sale's floor is the commitment plus that
    // same overhead. Unreachable while the drift is positive, and kept for the direction it
    // would fail in.
    const c = sized(DEEP, { kycWindowMinutes: 0 });
    expect(c.driftCash).toBe(0n);
    expect(c.planck + c.overhead).toBeLessThanOrEqual(c.quotedOut);
  });

  it("refuses a sale that cannot cover the payment's own costs", () => {
    expect(() => sized(DEEP, { transferFeePlanck: 10n ** 18n })).toThrow(CommitmentTooSmallError);
    expect(() => sized(DEEP, { cashToSell: 1n })).toThrow(CommitmentTooSmallError);
  });

  it("refuses a provider more precise than the asset", () => {
    expect(() => sized(DEEP, { providerDecimals: 12 })).toThrow(/more decimals/);
  });
});
