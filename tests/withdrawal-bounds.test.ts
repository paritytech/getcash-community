// Tests the off-ramp sale floor as sizeXcm ships it (saleBounds with the 5% ceiling). The main
// check: no sale traps on Asset Hub wherever `overCapacity` is false.
//
//   BOUNDS_REPORT=1 pnpm vitest run tests/withdrawal-bounds.test.ts   # also prints the tables

import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONCURRENCY,
  MARKET_MOVE_PCT,
  amountOut,
  withdrawalBounds,
  type OrientedReserves,
} from "@getsome/funding";
import {
  ASSET_HUB_FEE_BUFFER_CASH,
  DEFAULT_WITHDRAW_SLIPPAGE_PCT,
  TYPICAL_WITHDRAWAL_CASH,
  saleBounds,
} from "@getsome/withdraw";

const FEE = 3_000n;
const REPORT = process.env.BOUNDS_REPORT === "1";
const say = (...a: unknown[]) => {
  if (REPORT) console.log(...a);
};

/** Asset Hub's pool as measured 2026-09-25. */
const MEASURED = { pas: 421_298_658_123_227n, cash: 103_995_356_467n };
const CASH = (n: number) => BigInt(Math.round(n * 1e6));
const pad = (s: string | number, n: number) => String(s).padStart(n);

/** A pool of the given CASH depth at the measured price, oriented CASH in, PAS out. */
function poolAt(cashDepth: number): OrientedReserves {
  const m = (cashDepth * 1e6) / Number(MEASURED.cash);
  return {
    in: (MEASURED.cash * BigInt(Math.round(m * 1e6))) / 1_000_000n,
    out: (MEASURED.pas * BigInt(Math.round(m * 1e6))) / 1_000_000n,
  };
}

/** Dense up to today's depth, where the ceiling binds, then out to 10M. */
const DEPTHS: Array<[string, number]> = [
  ["26k", 26_000],
  ["47k", 47_000],
  ["52k", 52_000],
  ["60k", 60_000],
  ["75k", 75_000],
  ["90k", 90_000],
  ["95k", 95_000],
  ["100k", 100_000],
  ["104k live", 103_995],
  ["160k", 160_000],
  ["425k", 425_000],
  ["2.5M", 2_500_000],
  ["10M", 10_000_000],
];
const SIZES = [1, 5, 10, 50, 100, 500, 1000, 5000];

/** The bound sizeXcm would ship for this withdrawal, from saleBounds itself. */
function shipped(reserves: OrientedReserves, sellCash: bigint) {
  const quoted = amountOut(sellCash, reserves, FEE) ?? 0n;
  return {
    quoted,
    ...saleBounds({
      reserves,
      quoted,
      cashOnKey: sellCash,
      ceilingPct: DEFAULT_WITHDRAW_SLIPPAGE_PCT,
      feePpm: FEE,
    }),
  };
}

/** The pool after the market moves the sale's price down by `pct`, with the product unchanged. */
function marketMoved(pool: OrientedReserves, pct: number): OrientedReserves {
  if (pct <= 0) return pool;
  const f = Math.sqrt(1 - pct / 100);
  const SCALE = 1_000_000_000;
  return {
    in: (pool.in * BigInt(SCALE)) / BigInt(Math.round(f * SCALE)),
    out: (pool.out * BigInt(Math.round(f * SCALE))) / BigInt(SCALE),
  };
}

/**
 * Runs one sale behind `siblings` typical sales quoted at the same head, with the market moved
 * `marketPct` against it. True when it comes in under the floor and traps on Asset Hub.
 */
function traps(
  reserves: OrientedReserves,
  sellCash: bigint,
  safetyPct: number,
  siblings: number,
  marketPct = 0,
): boolean {
  const quoted = amountOut(sellCash, reserves, FEE);
  if (quoted === null) return true;
  const floor = (quoted * BigInt(Math.round((100 - safetyPct) * 100))) / 10_000n;
  const sibling = TYPICAL_WITHDRAWAL_CASH - ASSET_HUB_FEE_BUFFER_CASH;

  let pool = reserves;
  for (let i = 0; i < siblings; i += 1) {
    const got = amountOut(sibling, pool, FEE);
    if (got === null) return true;
    pool = { in: pool.in + sibling, out: pool.out - got };
  }
  pool = marketMoved(pool, marketPct);
  const got = amountOut(sellCash - ASSET_HUB_FEE_BUFFER_CASH, pool, FEE);
  return got === null || got < floor;
}

/** How many typical siblings the bound survives before the first trap, with no market move. */
function queueSurvived(reserves: OrientedReserves, sellCash: bigint, safetyPct: number): number {
  let n = 0;
  while (n < 4096 && !traps(reserves, sellCash, safetyPct, n)) n += 1;
  return n;
}

describe("the off-ramp bound as shipped", () => {
  it("shows the seller the same number the chain enforces", () => {
    // A promise tighter than the floor would let a sale execute and still under-deliver.
    for (const [, depth] of DEPTHS) {
      for (const size of SIZES) {
        const b = shipped(poolAt(depth), CASH(size));
        expect(b.promisePct).toBe(b.safetyPct);
      }
    }
  });

  it("ships 5% with overCapacity on today's pool, and less than 5% from 160k up", () => {
    // Today's pool asks for more than the ceiling, so 5% ships with the flag set.
    const live = shipped(poolAt(103_995), CASH(100));
    expect(live.safetyPct).toBe(DEFAULT_WITHDRAW_SLIPPAGE_PCT);
    expect(live.overCapacity).toBe(true);
    for (const depth of [160_000, 425_000, 2_500_000, 10_000_000]) {
      const b = shipped(poolAt(depth), CASH(100));
      expect(b.safetyPct).toBeLessThan(DEFAULT_WITHDRAW_SLIPPAGE_PCT);
      expect(b.overCapacity).toBe(false);
    }
  });

  it("tightens as the pool deepens, down to the 2% floor, and keeps the market move", () => {
    const at = (depth: number) => shipped(poolAt(depth), CASH(100)).safetyPct;
    expect(at(2_500_000)).toBeLessThan(at(160_000));
    expect(at(160_000)).toBeLessThanOrEqual(at(26_000));
    for (const [, depth] of DEPTHS) expect(at(depth)).toBeGreaterThanOrEqual(2);
    // At 425k the bound sits above the floor, so the market term shows in what ships.
    const reserves = poolAt(425_000);
    const quoted = amountOut(CASH(100), reserves, FEE)!;
    const withoutMarket = withdrawalBounds({
      reserves,
      tradeOut: quoted,
      feeTakenFromTrade: (quoted * ASSET_HUB_FEE_BUFFER_CASH) / CASH(100),
      referenceTrade: (quoted * TYPICAL_WITHDRAWAL_CASH) / CASH(100),
      marketMovePct: 0,
      floorPct: 0,
      feePpm: FEE,
    }).safetyPct;
    expect(at(425_000) - withoutMarket).toBeGreaterThan(MARKET_MOVE_PCT.instant - 0.02);
  });

  it("never traps behind the siblings and the market move where overCapacity is false", () => {
    // The window the bound is sized for: DEFAULT_CONCURRENCY sales ahead, then the market move.
    const market = MARKET_MOVE_PCT.instant - 0.01;
    let checked = 0;
    for (const [, depth] of DEPTHS) {
      for (const size of SIZES) {
        const reserves = poolAt(depth);
        const b = shipped(reserves, CASH(size));
        if (b.overCapacity) continue; // the flag already says this one may trap
        checked += 1;
        for (let siblings = 0; siblings <= DEFAULT_CONCURRENCY; siblings += 1) {
          expect(traps(reserves, CASH(size), b.safetyPct, siblings, market)).toBe(false);
        }
      }
    }
    // Guards against a pass that checked nothing.
    expect(checked).toBeGreaterThan(20);
  });

  it("overCapacity is true wherever the ceiling cut the bound below what the pool asked for", () => {
    // The flag has to be judged after the ceiling cut, not before.
    for (const [, depth] of DEPTHS) {
      for (const size of SIZES) {
        const reserves = poolAt(depth);
        const b = shipped(reserves, CASH(size));
        const unclamped = saleBounds({
          reserves,
          quoted: b.quoted,
          cashOnKey: CASH(size),
          ceilingPct: 100,
          feePpm: FEE,
        });
        if (unclamped.safetyPct > b.safetyPct) expect(b.overCapacity).toBe(true);
      }
    }
  });

  it("concurrency 24 survives about 24 typical sales at every depth, and 12 survives fewer", () => {
    // The dial counts typical 100 CASH sales, so 24 means about 2,400 CASH at any depth.
    for (const depth of [160_000, 425_000, 2_500_000]) {
      const reserves = poolAt(depth);
      const quoted = amountOut(CASH(100), reserves, FEE) ?? 0n;
      const dial = (c: number) =>
        withdrawalBounds({
          reserves,
          tradeOut: quoted,
          feeTakenFromTrade: (quoted * ASSET_HUB_FEE_BUFFER_CASH) / CASH(100),
          referenceTrade: (quoted * TYPICAL_WITHDRAWAL_CASH) / CASH(100),
          concurrency: c,
          // The dial alone: no market move and no policy floor.
          marketMovePct: 0,
          floorPct: 0,
          feePpm: FEE,
        }).safetyPct;
      const at24 = queueSurvived(reserves, CASH(100), dial(24));
      expect(at24).toBeGreaterThanOrEqual(DEFAULT_CONCURRENCY);
      expect(at24).toBeLessThanOrEqual(DEFAULT_CONCURRENCY + 6);
      expect(queueSurvived(reserves, CASH(100), dial(12))).toBeLessThan(at24);
    }
  });

  if (REPORT) {
    it("report", () => {
      say("\n═══ THE SHIPPED BOUND, 100 CASH WITHDRAWAL (ceiling 5%, market term included) ═══\n");
      say(
        `  ${pad("pool", 12)}${pad("derived", 10)}${pad("shipped", 10)}${pad("over", 7)}${pad("queue", 8)}${pad("min vs 5%", 12)}`,
      );
      for (const [name, depth] of DEPTHS) {
        const reserves = poolAt(depth);
        const b = shipped(reserves, CASH(100));
        const derived = saleBounds({
          reserves,
          quoted: b.quoted,
          cashOnKey: CASH(100),
          ceilingPct: 100,
          feePpm: FEE,
        }).safetyPct;
        const gain = (Number(b.quoted) / 1e10) * ((5 - b.safetyPct) / 100);
        say(
          `  ${pad(name, 12)}${pad(`${derived.toFixed(2)}%`, 10)}${pad(`${b.safetyPct.toFixed(2)}%`, 10)}` +
            `${pad(b.overCapacity ? "yes" : "no", 7)}${pad(queueSurvived(reserves, CASH(100), b.safetyPct), 8)}` +
            `${pad(`+${gain.toFixed(4)} PAS`, 12)}`,
        );
      }

      // The dial as shipped, with the ceiling and the market term.
      say("\n═══ THE CONCURRENCY DIAL, as shipped ═══\n");
      say(
        `  ${pad("concurrency", 14)}${pad("104k", 10)}${pad("queue", 7)}${pad("160k", 10)}${pad("queue", 7)}${pad("2.5M", 10)}${pad("queue", 7)}`,
      );
      for (const c of [2, 6, 12, 24, 50]) {
        const cells = [103_995, 160_000, 2_500_000].map((depth) => {
          const r = poolAt(depth);
          const quoted = amountOut(CASH(100), r, FEE) ?? 0n;
          const b = withdrawalBounds({
            reserves: r,
            tradeOut: quoted,
            feeTakenFromTrade: (quoted * ASSET_HUB_FEE_BUFFER_CASH) / CASH(100),
            referenceTrade: (quoted * TYPICAL_WITHDRAWAL_CASH) / CASH(100),
            concurrency: c,
            ceilingPct: DEFAULT_WITHDRAW_SLIPPAGE_PCT,
            feePpm: FEE,
          });
          return `${pad(`${b.safetyPct.toFixed(2)}%${b.overCapacity ? "*" : ""}`, 10)}${pad(queueSurvived(r, CASH(100), b.safetyPct), 7)}`;
        });
        say(`  ${pad(c, 14)}${cells.join("")}`);
      }
      say("  (* overCapacity: the ceiling or the cap cut the bound below what the dial asks for)");
    });
  }
});
