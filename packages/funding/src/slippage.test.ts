import { describe, expect, it } from "vitest";
import {
  ADVERSE_FLOW_MULTIPLE,
  EXTERNAL_POOL_FLOOR_PCT,
  MARKET_MOVE_PCT,
  MAX_SLIPPAGE_PCT,
  SLIPPAGE_STEP_PCT,
  derivedFloorPct,
  absorbableFlow,
  adverseMovePct,
  amountIn,
  amountOut,
  marketMovePct,
  slippageFor,
  withdrawalBounds,
  type OrientedReserves,
} from "./slippage";

/** Measured Paseo Asset Hub reserves: PAS in, CASH out. */
const AH: OrientedReserves = { in: 411_831_067_975_701n, out: 106_378_021_598n };
/** Measured Paseo People reserves: CASH in, PAS out. */
const PEOPLE: OrientedReserves = { in: 4_013_999_606n, out: 9_965_227_563_804n };
const DEEP: OrientedReserves = { in: AH.in * 24n, out: AH.out * 24n };

const CASH = (n: number) => BigInt(Math.round(n * 1e6));
const EXPOSURES = ["instant", "hours", "days"] as const;

describe("the pallet's curve", () => {
  it("matches the chain's own quote on the People pool", () => {
    // Read from `quote_price_tokens_for_exact_tokens` on the live chain.
    const cases: Array<[bigint, bigint]> = [
      [BigInt(0.1 * 1e10), 404_054n],
      [BigInt(0.42 * 1e10), 1_697_569n],
      [BigInt(1 * 1e10), 4_044_185n],
      [BigInt(5 * 1e10), 20_302_499n],
    ];
    for (const [pasOut, expected] of cases) {
      expect(amountIn(pasOut, PEOPLE)).toBe(expected);
    }
  });

  it("round-trips: an exact-out cost spent as an exact-in buys back at least as much", () => {
    const want = CASH(50);
    const cost = amountIn(want, AH);
    expect(cost).not.toBeNull();
    expect(amountOut(cost as bigint, AH)).toBeGreaterThanOrEqual(want);
  });

  it("refuses a trade the pool cannot supply, and an empty pool", () => {
    expect(amountIn(AH.out, AH)).toBeNull();
    expect(amountIn(AH.out + 1n, AH)).toBeNull();
    expect(amountIn(0n, AH)).toBeNull();
    expect(amountIn(CASH(1), { in: 0n, out: 0n })).toBeNull();
    expect(amountOut(CASH(1), { in: 0n, out: 0n })).toBeNull();
  });
});

describe("adverseMovePct and absorbableFlow", () => {
  it("agrees with the live measurement: 1000 CASH ahead of a 50 CASH buy moves it about 1.9%", () => {
    expect(adverseMovePct(CASH(50), AH, CASH(1000))).toBeCloseTo(1.91, 1);
  });

  it("is close to 2 x flow / reserve for a small flow and above it for a large one", () => {
    const approx = (flow: bigint) => (2 * Number(flow) * 100) / Number(AH.out);
    expect(adverseMovePct(CASH(50), AH, CASH(1000)) as number).toBeCloseTo(approx(CASH(1000)), 0);
    expect(adverseMovePct(CASH(50), AH, CASH(10_000)) as number).toBeGreaterThan(
      approx(CASH(10_000)),
    );
  });

  it("grows with the flow", () => {
    let last = 0;
    for (const n of [100, 500, 1000, 5000, 10_000]) {
      const move = adverseMovePct(CASH(50), AH, CASH(n)) as number;
      expect(move).toBeGreaterThan(last);
      last = move;
    }
  });

  it("inverts: the flow returned lands on the headroom and one unit more goes past it", () => {
    const flow = absorbableFlow(CASH(50), AH, 5);
    expect(adverseMovePct(CASH(50), AH, flow) as number).toBeLessThanOrEqual(5);
    expect(adverseMovePct(CASH(50), AH, flow + 1n) as number).toBeGreaterThan(5);
    expect(Number(flow) / 1e6).toBeGreaterThan(2_400);
    expect(Number(flow) / 1e6).toBeLessThan(2_700);
    expect(Number(absorbableFlow(CASH(50), DEEP, 5))).toBeGreaterThan(Number(flow) * 20);
    expect(absorbableFlow(CASH(50), AH, 0)).toBe(0n);
  });
});

describe("slippageFor", () => {
  it("asks for more counted-flow headroom the longer the exposure", () => {
    // Without the market move, which is not ordered by window.
    const at = (exposure: (typeof EXPOSURES)[number]) =>
      slippageFor({ reserves: DEEP, tradeOut: CASH(50), exposure, marketMovePct: 0 }).pct;
    expect(at("instant")).toBeLessThan(at("hours"));
    expect(at("hours")).toBeLessThan(at("days"));
  });

  it("adds each exposure's market move on top of the counted flow", () => {
    for (const exposure of EXPOSURES) {
      const without = slippageFor({
        reserves: DEEP,
        tradeOut: CASH(50),
        exposure,
        marketMovePct: 0,
      });
      const withMarket = slippageFor({ reserves: DEEP, tradeOut: CASH(50), exposure });
      expect(withMarket.marketPct).toBe(MARKET_MOVE_PCT[exposure]);
      expect(Math.abs(withMarket.pct - without.pct - MARKET_MOVE_PCT[exposure])).toBeLessThan(
        0.011,
      );
    }
  });

  it("never falls below the market move, however deep the pool", () => {
    for (const m of [1n, 24n, 100n, 10_000n]) {
      const reserves = { in: AH.in * m, out: AH.out * m };
      for (const exposure of EXPOSURES) {
        const d = slippageFor({ reserves, tradeOut: CASH(50), exposure });
        if (!d.cappedOut) expect(d.pct).toBeGreaterThanOrEqual(MARKET_MOVE_PCT[exposure]);
      }
    }
  });

  it("asks for less on a deeper pool, and more for a larger trade", () => {
    const here = slippageFor({ reserves: AH, tradeOut: CASH(50), exposure: "days" });
    const there = slippageFor({ reserves: DEEP, tradeOut: CASH(50), exposure: "days" });
    expect(there.pct).toBeLessThan(here.pct);
    const large = slippageFor({ reserves: DEEP, tradeOut: CASH(2000), exposure: "days" });
    expect(large.pct).toBeGreaterThan(there.pct);
  });

  it("keeps a policy floor under the result, and leaves the value alone above it", () => {
    const huge: OrientedReserves = { in: AH.in * 10_000n, out: AH.out * 10_000n };
    const bare = slippageFor({ reserves: huge, tradeOut: CASH(1), exposure: "instant" });
    expect(bare.pct).toBeLessThan(EXTERNAL_POOL_FLOOR_PCT);
    const floored = slippageFor({
      reserves: huge,
      tradeOut: CASH(1),
      exposure: "instant",
      floorPct: EXTERNAL_POOL_FLOOR_PCT,
    });
    expect(floored.pct).toBe(EXTERNAL_POOL_FLOOR_PCT);
    const thin = slippageFor({ reserves: AH, tradeOut: CASH(100), exposure: "days" });
    const thinFloored = slippageFor({
      reserves: AH,
      tradeOut: CASH(100),
      exposure: "days",
      floorPct: EXTERNAL_POOL_FLOOR_PCT,
    });
    expect(thinFloored.pct).toBe(thin.pct);
  });

  it("keeps at least one step of movement on top of a fee, however deep the pool", () => {
    // The flow moves the price by less than a step, so only the step leaves room above the fee.
    const huge: OrientedReserves = { in: AH.in * 10_000n, out: AH.out * 10_000n };
    const d = slippageFor({
      reserves: huge,
      tradeOut: CASH(1),
      exposure: "instant",
      adverseFlowMultiple: 1e-9,
      marketMovePct: 0,
      feeTakenFromTrade: CASH(0.005),
    });
    expect(d.floor.feePct).toBeCloseTo(0.5, 6);
    expect(d.pct).toBeGreaterThanOrEqual(0.5 + SLIPPAGE_STEP_PCT);
    expect(d.pct).toBeLessThan(0.6);
    expect(d.cappedOut).toBe(false);
  });

  it("uses a typical reference trade, so a large trade does not invent traffic its own size", () => {
    const ownScaled = slippageFor({ reserves: DEEP, tradeOut: CASH(2000), exposure: "days" });
    const pinned = slippageFor({
      reserves: DEEP,
      tradeOut: CASH(2000),
      exposure: "days",
      referenceTrade: CASH(100),
    });
    expect(pinned.pct).toBeLessThan(ownScaled.pct);
  });

  it("stays inside the band for every exposure on both measured pools", () => {
    for (const reserves of [AH, PEOPLE]) {
      for (const exposure of Object.keys(ADVERSE_FLOW_MULTIPLE) as Array<
        keyof typeof ADVERSE_FLOW_MULTIPLE
      >) {
        const d = slippageFor({ reserves, tradeOut: reserves.out / 10_000n, exposure });
        expect(d.pct).toBeGreaterThanOrEqual(d.floor.pct);
        expect(d.pct).toBeGreaterThanOrEqual(SLIPPAGE_STEP_PCT);
        expect(d.pct).toBeLessThanOrEqual(MAX_SLIPPAGE_PCT);
        expect(() => BigInt(Math.round((100 + d.pct) * 100))).not.toThrow();
      }
    }
  });

  it("returns clean two-decimal values that encode exactly", () => {
    for (const m of [1n, 4n, 24n]) {
      const reserves = { in: AH.in * m, out: AH.out * m };
      for (const exposure of EXPOSURES) {
        const pct = slippageFor({ reserves, tradeOut: CASH(100), exposure }).pct;
        expect(pct).toBe(Number(pct.toFixed(2)));
      }
    }
  });
});

describe("derivedFloorPct", () => {
  it("tracks depth", () => {
    const floorAt = (m: bigint) =>
      derivedFloorPct({
        reserves: { in: AH.in * m, out: AH.out * m },
        tradeOut: CASH(100),
        competingTrade: CASH(100),
      }).pct;
    expect(floorAt(24n)).toBeLessThan(floorAt(4n));
    expect(floorAt(4n)).toBeLessThan(floorAt(1n));
  });

  it("keeps the fee as a share of the trade, so small trades stay the expensive case", () => {
    const fee = CASH(0.01);
    const small = derivedFloorPct({ reserves: DEEP, tradeOut: CASH(1), feeTakenFromTrade: fee });
    const large = derivedFloorPct({ reserves: DEEP, tradeOut: CASH(100), feeTakenFromTrade: fee });
    expect(small.feePct).toBeGreaterThan(large.feePct);
    expect(small.pct).toBeGreaterThan(large.pct);
  });

  it("treats a competing trade the pool cannot clear as the cap", () => {
    const f = derivedFloorPct({ reserves: AH, tradeOut: CASH(50), competingTrade: AH.out });
    expect(f.competitionPct).toBe(MAX_SLIPPAGE_PCT);
  });
});

describe("pools that cannot carry the trade read as unavailable", () => {
  const cases: Array<[string, OrientedReserves, bigint]> = [
    ["empty pool", { in: 0n, out: 0n }, CASH(50)],
    ["dust pool", { in: 1n, out: 1n }, CASH(50)],
    ["trade above the out reserve", AH, AH.out + 1n],
    ["trade exactly the out reserve", AH, AH.out],
    ["trade leaving one unit", AH, AH.out - 1n],
    ["negative reserves", { in: -5n, out: -5n }, CASH(50)],
    ["zero trade", AH, 0n],
    ["pool too thin for the trade", { in: 1_000_000n, out: 1_000_000n }, CASH(0.9)],
  ];
  for (const [name, reserves, tradeOut] of cases) {
    it(name, () => {
      const d = slippageFor({ reserves, tradeOut, exposure: "days" });
      expect(d.cappedOut).toBe(true);
      expect(d.pct).toBe(MAX_SLIPPAGE_PCT);
    });
  }

  it("does not throw or return NaN on inputs that are not numbers", () => {
    for (const bad of [NaN, Infinity, -1]) {
      const d = slippageFor({
        reserves: AH,
        tradeOut: CASH(50),
        exposure: "days",
        adverseFlowMultiple: bad,
        marketMovePct: bad,
        floorPct: bad,
      });
      expect(Number.isFinite(d.pct)).toBe(true);
    }
  });
});

describe("withdrawalBounds", () => {
  const sale: OrientedReserves = { in: AH.out, out: AH.in };
  const quoted = amountOut(CASH(100), sale)!;
  const bounds = (extra: Partial<Parameters<typeof withdrawalBounds>[0]> = {}) =>
    withdrawalBounds({
      reserves: sale,
      tradeOut: quoted,
      feeTakenFromTrade: (quoted * 10_000n) / CASH(100),
      referenceTrade: quoted,
      ...extra,
    });

  it("ships one number as both the floor and the promise", () => {
    const b = bounds();
    expect(b.promisePct).toBe(b.safetyPct);
  });

  it("clamps to the ceiling, rounded down to the step, and then says it is over capacity", () => {
    const b = bounds({ ceilingPct: 4.999 });
    expect(b.safetyPct).toBe(4.99);
    expect(b.overCapacity).toBe(true);
    expect(bounds({ ceilingPct: 100 }).overCapacity).toBe(false);
  });

  it("reads a bad market override as zero, so it cannot hide a gap", () => {
    expect(bounds({ marketMovePct: NaN, ceilingPct: 1 }).overCapacity).toBe(true);
  });

  it("accepts a fractional concurrency without throwing", () => {
    expect(() => bounds({ concurrency: 24.5 })).not.toThrow();
    expect(bounds({ concurrency: 24.5 }).safetyPct).toBeGreaterThanOrEqual(bounds().safetyPct);
  });

  it("keeps the external pool floor under the bound on a deep pool", () => {
    const deepSale: OrientedReserves = { in: sale.in * 100n, out: sale.out * 100n };
    const deepQuote = amountOut(CASH(100), deepSale)!;
    const b = withdrawalBounds({
      reserves: deepSale,
      tradeOut: deepQuote,
      referenceTrade: deepQuote,
    });
    expect(b.safetyPct).toBe(EXTERNAL_POOL_FLOOR_PCT);
    expect(b.overCapacity).toBe(false);
  });
});

describe("marketMovePct", () => {
  it("scales with volatility and the root of the window, and is zero for nonsense", () => {
    const base = marketMovePct({ sigmaPerYear: 0.8, windowSeconds: 1800, z: 2.5 });
    expect(marketMovePct({ sigmaPerYear: 1.6, windowSeconds: 1800, z: 2.5 })).toBeCloseTo(base * 2);
    expect(marketMovePct({ sigmaPerYear: 0.8, windowSeconds: 7200, z: 2.5 })).toBeCloseTo(base * 2);
    expect(marketMovePct({ sigmaPerYear: 0, windowSeconds: 1800, z: 2.5 })).toBe(0);
    expect(marketMovePct({ sigmaPerYear: NaN, windowSeconds: 1800, z: 2.5 })).toBe(0);
  });
});
