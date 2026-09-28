// Tests the on-ramp deposit headroom (`headroomFor`) and each rail's exposure window. No chain.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SLIPPAGE_PCT,
  MARKET_MOVE_PCT,
  MAX_SLIPPAGE_PCT,
  derivedFloorPct,
  type OrientedReserves,
} from "@getsome/funding";
import { exposureForSource, headroomFor } from "../lib/funding-fees";

/** Asset Hub as measured on 2026-09-22: PAS in, CASH out. */
const AH: OrientedReserves = { in: 411_831_067_975_701n, out: 106_378_021_598n };
const CASH = (n: number) => BigInt(Math.round(n * 1e6));
const FEE = 3_000n;

const at = (reserves: OrientedReserves, buy: bigint, sourceId: string) =>
  headroomFor({ reserves, buyTarget: buy, exposure: exposureForSource(sourceId), feePpm: FEE });

describe("exposureForSource", () => {
  it("maps each rail to how long its deposit is in flight", () => {
    expect(exposureForSource("meld-bank")).toBe("days");
    expect(exposureForSource("meld-card")).toBe("hours");
    expect(exposureForSource("btc")).toBe("minutes");
    expect(exposureForSource("eth")).toBe("minutes");
    expect(exposureForSource("dot-assethub")).toBe("minutes");
  });

  it("treats an unknown source as a fast rail, still no lower than the pool's floor", () => {
    expect(exposureForSource("something-new")).toBe("minutes");
    const decision = at(AH, CASH(100), "something-new");
    const floor = derivedFloorPct({
      reserves: AH,
      tradeOut: CASH(100),
      competingTrade: CASH(100),
      feePpm: FEE,
    });
    expect(decision.pct).toBeGreaterThanOrEqual(floor.pct);
  });
});

describe("headroomFor", () => {
  it("never returns less than the pool's own floor", () => {
    for (const source of ["btc", "meld-card", "meld-bank"]) {
      for (const n of [10, 50, 100, 500, 1000]) {
        const floor = derivedFloorPct({
          reserves: AH,
          tradeOut: CASH(n),
          competingTrade: CASH(100),
          feePpm: FEE,
        });
        expect(at(AH, CASH(n), source).pct).toBeGreaterThanOrEqual(floor.pct);
      }
    }
  });

  it("falls as the pool deepens, to below the 5% default", () => {
    // A 5% floor would hide the computation on any pool deeper than today's.
    const seen = [1, 4, 24].map((m) => {
      const deeper: OrientedReserves = {
        in: AH.in * BigInt(m),
        out: AH.out * BigInt(m),
      };
      return at(deeper, CASH(100), "meld-bank").pct;
    });
    expect(seen[1]!).toBeLessThan(seen[0]!);
    expect(seen[2]!).toBeLessThan(seen[1]!);
    // At 2.5M little is left but the bank rail's market move, which does not shrink with depth.
    expect(seen[2]!).toBeLessThan(DEFAULT_SLIPPAGE_PCT);
    expect(seen[2]!).toBeGreaterThanOrEqual(MARKET_MOVE_PCT.days);
    expect(seen[2]! - MARKET_MOVE_PCT.days).toBeLessThan(0.5);
  });

  it("carries one dispatch fee, so a single rejected submit does not strand the deposit", () => {
    // Today's pool, because its value sits above the 2% floor where the extra fee shows.
    const pool: OrientedReserves = AH;
    const DISPATCH = 150_000_000n;
    for (const n of [10, 100, 500]) {
      const bare = headroomFor({
        reserves: pool,
        buyTarget: CASH(n),
        exposure: "minutes",
        feePpm: FEE,
      });
      const cushioned = headroomFor({
        reserves: pool,
        buyTarget: CASH(n),
        exposure: "minutes",
        feePpm: FEE,
        dispatchNative: DISPATCH,
      });
      const quote = Number((CASH(n) * pool.in) / pool.out);
      const share = (Number(DISPATCH) / quote) * 100;
      expect(cushioned.pct - bare.pct).toBeGreaterThanOrEqual(share - 0.011);
      expect(cushioned.pct - bare.pct).toBeLessThanOrEqual(share + 0.021);
    }
  });

  it("has a floor above 5% on its own when the pool is too thin for the purchase", () => {
    const thin: OrientedReserves = { in: AH.in / 26n, out: AH.out / 26n };
    const floor = derivedFloorPct({
      reserves: thin,
      tradeOut: CASH(100),
      competingTrade: CASH(100),
      feePpm: FEE,
    });
    expect(floor.pct).toBeGreaterThan(DEFAULT_SLIPPAGE_PCT);
  });

  it("rises above 5% when the pool is thin for the purchase", () => {
    const thin: OrientedReserves = { in: AH.in / 20n, out: AH.out / 20n };
    const decision = at(thin, CASH(1000), "meld-bank");
    expect(decision.pct).toBeGreaterThan(DEFAULT_SLIPPAGE_PCT);
  });

  it("asks more for a longer window", () => {
    // On today's pool, where neither value is at the cap or the floor.
    const fast = at(AH, CASH(100), "btc").pct;
    const slow = at(AH, CASH(100), "meld-bank").pct;
    expect(fast).toBeGreaterThan(2);
    expect(slow).toBeLessThan(10);
    expect(slow).toBeGreaterThan(fast);
  });

  it("flags a pool that cannot price the purchase as unavailable, at the cap", () => {
    // On this flag a fresh hosted quote is refused before the buyer pays.
    const tiny: OrientedReserves = { in: CASH(50), out: CASH(50) };
    const decision = headroomFor({
      reserves: tiny,
      buyTarget: CASH(40),
      exposure: "days",
      feePpm: FEE,
    });
    expect(decision.unavailable).toBe(true);
    expect(decision.pct).toBe(MAX_SLIPPAGE_PCT);
  });

  it("flags an empty pool as unavailable rather than as the safest pool it has seen", () => {
    for (const reserves of [
      { in: 0n, out: 0n },
      { in: 1n, out: 1n },
    ] as OrientedReserves[]) {
      const decision = headroomFor({
        reserves,
        buyTarget: CASH(100),
        exposure: "days",
        feePpm: FEE,
      });
      expect(decision.unavailable).toBe(true);
    }
  });

  it("returns a value inside the cap for every size the product sells", () => {
    // A flagged pool still gets a value, since a re-opened request carries on with it.
    for (const n of [10, 50, 100, 200, 500]) {
      const d = at(AH, CASH(n), "meld-bank");
      expect(d.pct).toBeGreaterThan(0);
      expect(d.pct).toBeLessThanOrEqual(MAX_SLIPPAGE_PCT);
    }
    // A fast rail at an ordinary size is comfortably inside the pool's capacity.
    expect(at(AH, CASH(100), "btc").unavailable).toBe(false);
  });

  it("takes the LP fee it is given rather than assuming one", () => {
    const withFee = (feePpm: bigint) =>
      headroomFor({ reserves: AH, buyTarget: CASH(100), exposure: "minutes", feePpm }).pct;
    expect(withFee(30_000n)).toBeGreaterThan(withFee(0n));
    expect(withFee(30_000n)).toBeLessThan(10);
  });
});
