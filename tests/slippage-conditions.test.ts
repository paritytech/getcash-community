// The slippage figures against what they are meant to hold to: the routes through the Asset Hub
// pool run on a dry-run figure with 0.7 to 1% headroom, and a purchase through it pays about 1.5%
// over spot.
//
// Each pool is a snapshot of its reserves at one block, with the chain's own quotes at that block:
// Paseo Asset Hub next v2's PAS/CASH pool, the one the app trades on, and a pool some 28 times
// deeper, to see the figures hold with more liquidity behind them.
// The pool model here is pallet-asset-conversion's own constant-product math and must give the
// chain's answers to the planck before anything is judged on it. The app's own code then runs
// against it: priceSale for a withdrawal's sale, and sizeNativeBudget and the conversion gate for
// a deposit on the pool tier.

import { describe, expect, it } from "vitest";
import { DEFAULT_SLIPPAGE_PCT, DIRECT_SLIPPAGE_PCT, sizeNativeBudget } from "@getsome/funding";
import { DEFAULT_WITHDRAW_SLIPPAGE_PCT, priceSale } from "@getsome/withdraw";
import { decideStep, quoteNativeIn } from "../packages/funding/src/pipeline";

const PPM = 1_000_000n;

/** pallet-asset-conversion's get_amount_out: what `amountIn` buys, the LP fee in ppm taken off. */
const amountOut = (amountIn: bigint, reserveIn: bigint, reserveOut: bigint, fee: bigint) => {
  const withFee = amountIn * (PPM - fee);
  return (withFee * reserveOut) / (reserveIn * PPM + withFee);
};

/** pallet-asset-conversion's get_amount_in: what buys exactly `out`. */
const amountIn = (out: bigint, reserveIn: bigint, reserveOut: bigint, fee: bigint) =>
  (reserveIn * out * PPM) / ((reserveOut - out) * (PPM - fee)) + 1n;

interface Snapshot {
  /** The native's reserve (10 decimals) and the other asset's (6 decimals), and the LP fee. */
  native: bigint;
  other: bigint;
  fee: bigint;
  /** The chain's answers at the snapshot's block, other asset amount -> native. */
  sells: [bigint, bigint][];
  buys: [bigint, bigint][];
}

/** A deep pool: 2.5M native against 2.87M of the stable, 0.3% fee. */
const DEEP: Snapshot = {
  native: 24_959_851_829_157_957n,
  other: 2_866_264_095_489n,
  fee: 3_000n,
  sells: [
    [10_000_000n, 86_819_933_143n],
    [100_000_000n, 868_172_152_914n],
    [1_000_000_000n, 8_679_004_612_737n],
    [10_000_000_000n, 86_519_286_843_512n],
  ],
  buys: [
    [10_000_000n, 87_343_814_838n],
    [100_000_000n, 873_465_575_075n],
    [1_000_000_000n, 8_737_399_368_760n],
    [10_000_000_000n, 87_649_306_444_717n],
  ],
};

/** Paseo Asset Hub next, block 1,876,814: PAS/CASH, asset 50000413. */
const PASEO: Snapshot = {
  native: 429_197_930_148_321n,
  other: 102_087_165_793n,
  fee: 3_000n,
  sells: [
    [10_000_000n, 41_912_080_396n],
    [100_000_000n, 418_752_775_160n],
    [1_000_000_000n, 4_151_077_258_724n],
    [10_000_000_000n, 38_186_789_156_201n],
  ],
  buys: [
    [10_000_000n, 42_172_937_993n],
    [100_000_000n, 422_101_540_911n],
    [1_000_000_000n, 4_258_595_984_627n],
    [10_000_000_000n, 46_748_034_282_110n],
  ],
};

const NATIVE = { parents: 1, interior: { type: "Here" } };
const isNative = (location: unknown) =>
  (location as { interior?: { type?: string } }).interior?.type === "Here";
const UNDERLYING_ID = 50_000_413;
const UNDERLYING = {
  parents: 0,
  interior: {
    type: "X2",
    value: [
      { type: "PalletInstance", value: 50 },
      { type: "GeneralIndex", value: BigInt(UNDERLYING_ID) },
    ],
  },
};

/** One pool, moved by the trades others make, and Asset Hub's runtime answering from it. */
class Pool {
  native: bigint;
  other: bigint;
  readonly fee: bigint;

  constructor(snapshot: Snapshot) {
    this.native = snapshot.native;
    this.other = snapshot.other;
    this.fee = snapshot.fee;
  }

  /** The native that selling `otherIn` lands. */
  sell(otherIn: bigint): bigint {
    return amountOut(otherIn, this.other, this.native, this.fee);
  }

  /** The native that buys exactly `otherOut`. */
  costOf(otherOut: bigint): bigint {
    return amountIn(otherOut, this.native, this.other, this.fee);
  }

  /** Others sell `otherIn` for the native first: a sale of the other asset now lands less. */
  othersSell(otherIn: bigint): this {
    const out = this.sell(otherIn);
    this.other += otherIn;
    this.native -= out;
    return this;
  }

  /** Others buy `otherOut` with the native first: buying it now costs more. */
  othersBuy(otherOut: bigint): this {
    const cost = this.costOf(otherOut);
    this.native += cost;
    this.other -= otherOut;
    return this;
  }

  /** The native one unit of the other asset is worth at the margin, fee aside, scaled by 1e12. */
  spot(): bigint {
    return (this.native * 1_000_000_000_000n) / this.other;
  }

  /** Asset Hub's runtime calls the app makes, answered from this pool. */
  api() {
    const quote = (give: unknown, amount: bigint, exactIn: boolean) => {
      const giveNative = isNative(give);
      if (exactIn) {
        return giveNative
          ? amountOut(amount, this.native, this.other, this.fee)
          : amountOut(amount, this.other, this.native, this.fee);
      }
      return giveNative
        ? amountIn(amount, this.native, this.other, this.fee)
        : amountIn(amount, this.other, this.native, this.fee);
    };
    return {
      query: {
        AssetConversion: {
          // The pool exists: it reads as its lp token id.
          Pools: { getValues: async () => [0] },
        },
      },
      apis: {
        AssetConversionApi: {
          quote_price_exact_tokens_for_tokens: async (give: unknown, _: unknown, amount: bigint) =>
            quote(give, amount, true),
          quote_price_tokens_for_exact_tokens: async (give: unknown, _: unknown, amount: bigint) =>
            quote(give, amount, false),
        },
      },
    };
  }
}

const USD = (dollars: number) => BigInt(Math.round(dollars * 1_000_000));
const pct = (num: bigint, den: bigint) => Number((num * 1_000_000n) / den) / 10_000;

/** The least `flow` (6-decimal units, to 1 USD) at which `breaks(flow)` turns true. */
function threshold(breaks: (flow: bigint) => boolean, upTo: bigint): bigint {
  let lo = 0n;
  let hi = upTo;
  if (!breaks(hi)) return hi;
  while (hi - lo > 1_000_000n) {
    const mid = (lo + hi) / 2n;
    if (breaks(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** The withdrawal sale's floor, as the worker prices it: priceSale at `slippagePct`. */
async function saleFloor(pool: Pool, cash: bigint, slippagePct: number): Promise<bigint> {
  const sale = await priceSale({
    assetHubApi: pool.api() as never,
    route: { tier: "pool" },
    cashOnKey: cash,
    remoteFeesCash: 0n,
    slippagePct,
    originHex: `0x${"07".repeat(32)}`,
    peopleParaId: 1004,
  });
  if (sale.tier !== "pool") throw new Error("the native sale prices on the pool");
  return sale.minNativeOut;
}

/** A deposit sized on the pool tier, as the app asks it: sizeNativeBudget, keep and buffer aside. */
async function depositAsked(pool: Pool, settle: bigint): Promise<bigint> {
  return sizeNativeBudget({
    client: { getTypedApi: () => pool.api() } as never,
    underlyingAssetId: UNDERLYING_ID,
    settleAmount: settle,
    remoteFeeBuffer: 0n,
    keepNativeForFees: 0n,
  });
}

describe("the pool snapshots", () => {
  it("are modelled to the planck: the model gives the chain's own quotes", () => {
    for (const snapshot of [DEEP, PASEO]) {
      const pool = new Pool(snapshot);
      for (const [cash, native] of snapshot.sells) expect(pool.sell(cash)).toBe(native);
      for (const [cash, native] of snapshot.buys) expect(pool.costOf(cash)).toBe(native);
    }
  });
});

describe("the slippage figures", () => {
  it("keep every pool route's headroom inside 0.7 to 1%", () => {
    for (const figure of [
      DEFAULT_SLIPPAGE_PCT,
      DIRECT_SLIPPAGE_PCT,
      DEFAULT_WITHDRAW_SLIPPAGE_PCT,
    ]) {
      expect(figure).toBeGreaterThanOrEqual(0.7);
      expect(figure).toBeLessThanOrEqual(1);
    }
  });
});

describe("a top-up through the deep pool", () => {
  it("pays about 1.5% over spot: the 1% headroom, the 0.3% pool fee and its own impact", async () => {
    for (const dollars of [10, 100, 1_000, 5_000]) {
      const pool = new Pool(DEEP);
      const asked = await depositAsked(pool, USD(dollars));
      const atSpot = (USD(dollars) * pool.spot()) / 1_000_000_000_000n;
      const over = pct(asked - atSpot, atSpot);
      expect(over).toBeGreaterThanOrEqual(1.3);
      expect(over).toBeLessThanOrEqual(1.5);
    }
  });

  it("converts while others' buying moved the pool less than the headroom, and waits beyond it", async () => {
    const settle = USD(100);
    const asked = await depositAsked(new Pool(DEEP), settle);
    // The gate asks the plain quote at conversion time, from the pool as others left it.
    const step = async (othersBought: bigint) => {
      const pool = new Pool(DEEP).othersBuy(othersBought);
      const needed = await quoteNativeIn(
        pool.api() as never,
        { native: NATIVE, underlying: UNDERLYING } as never,
        settle,
      );
      return decideStep(
        { depositAh: asked, underlyingPeople: 0n },
        { settleAmount: settle, depositNeeded: needed },
      );
    };
    const blocked = threshold(
      (flow) => new Pool(DEEP).othersBuy(flow).costOf(settle) > asked,
      USD(1_000_000),
    );
    // About $14k of other buying in the window before the deposit converts.
    expect(blocked).toBeGreaterThan(USD(13_000));
    expect(blocked).toBeLessThan(USD(16_000));
    expect(await step(blocked - USD(1_000))).toBe("swap");
    expect(await step(blocked + USD(1_000))).toBe("await-native");
  });
});

describe("a withdrawal's sale on the deep pool", () => {
  it("lands over its 1% floor at every size: the quote already counts the sale's own impact", async () => {
    for (const dollars of [10, 100, 1_000, 10_000]) {
      const pool = new Pool(DEEP);
      const floor = await saleFloor(pool, USD(dollars), DEFAULT_WITHDRAW_SLIPPAGE_PCT);
      const fill = pool.sell(USD(dollars));
      expect(fill).toBeGreaterThanOrEqual(floor);
      expect(pct(fill - floor, fill)).toBeGreaterThan(0.99);
    }
  });

  it("holds its 1% floor against about $14k of others' sales in its window, and half a point against $7k", async () => {
    for (const dollars of [100, 1_000]) {
      const sale = USD(dollars);
      const floors = {
        one: await saleFloor(new Pool(DEEP), sale, DEFAULT_WITHDRAW_SLIPPAGE_PCT),
        half: await saleFloor(new Pool(DEEP), sale, 0.5),
      };
      const traps = (floor: bigint) => (flow: bigint) =>
        new Pool(DEEP).othersSell(flow).sell(sale) < floor;
      const atOne = threshold(traps(floors.one), USD(1_000_000));
      const atHalf = threshold(traps(floors.half), USD(1_000_000));
      expect(atOne).toBeGreaterThan(USD(13_000));
      // Half a point holds too, against about half as much.
      expect(atHalf).toBeGreaterThan(USD(6_500));
      expect(atOne).toBeGreaterThan((atHalf * 19n) / 10n);
    }
  });

  it("rides out the largest 30 s move seen on the pool in a week, which half a point would not", async () => {
    // 0.565%: the pool's own price, sampled every block or so over a week.
    const sale = USD(100);
    const flowFor = (movePct: number) =>
      threshold(
        (flow) =>
          new Pool(DEEP).othersSell(flow).sell(sale) * 1_000_000n <
          new Pool(DEEP).sell(sale) * BigInt(Math.round((100 - movePct) * 10_000)),
        USD(1_000_000),
      );
    const move = new Pool(DEEP).othersSell(flowFor(0.565));
    expect(move.sell(sale)).toBeGreaterThanOrEqual(
      await saleFloor(new Pool(DEEP), sale, DEFAULT_WITHDRAW_SLIPPAGE_PCT),
    );
    expect(move.sell(sale)).toBeLessThan(await saleFloor(new Pool(DEEP), sale, 0.5));
  });
});

describe("on Paseo Asset Hub next v2's pool, the one the app trades on", () => {
  it("prices a pool top-up of 10 to 200 CASH at 1.3 to 1.5% over spot too", async () => {
    // 1.31% at 10 CASH up to 1.50% at 200, where the shallower pool's own impact adds 0.2%.
    for (const cash of [10, 50, 200]) {
      const pool = new Pool(PASEO);
      const asked = await depositAsked(pool, USD(cash));
      const atSpot = (USD(cash) * pool.spot()) / 1_000_000_000_000n;
      const over = pct(asked - atSpot, atSpot);
      expect(over).toBeGreaterThanOrEqual(1.3);
      expect(over).toBeLessThan(1.51);
    }
  });

  it("holds the 1% sale floor against about 500 CASH of others' sales, a pool some 28 times shallower", async () => {
    const sale = USD(100);
    const floor = await saleFloor(new Pool(PASEO), sale, DEFAULT_WITHDRAW_SLIPPAGE_PCT);
    const traps = threshold(
      (flow) => new Pool(PASEO).othersSell(flow).sell(sale) < floor,
      USD(100_000),
    );
    expect(traps).toBeGreaterThan(USD(480));
    expect(traps).toBeLessThan(USD(560));
  });
});
