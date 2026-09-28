// Many of our own requests quoted at one head, then executed in order, each moving the price for
// the next. Counts how many fit in a bound at A (on-ramp), B (off-ramp sale) and C (fee swap).
//
//   CONCURRENCY_REPORT=1 pnpm vitest run tests/slippage-concurrency.test.ts   # prints the tables

import { describe, expect, it } from "vitest";
import { ASSET_HUB_FEE_BUFFER_CASH, saleBounds, swapHeadroomPct } from "@getsome/withdraw";
import { headroomFor } from "../lib/funding-fees";
import {
  ADVERSE_FLOW_MULTIPLE,
  amountIn,
  amountOut,
  derivedFloorPct,
  type OrientedReserves,
} from "@getsome/funding";

const FEE = 3_000n;
const REPORT = process.env.CONCURRENCY_REPORT === "1";
const say = (...a: unknown[]) => {
  if (REPORT) console.log(...a);
};

/** Asset Hub as measured 2026-09-22. */
const AH = { pas: 411_831_067_975_701n, cash: 106_378_021_598n };
/** People as measured the same day: the fee-swap pool, twenty-six times thinner. */
const PE = { pas: 9_965_227_563_804n, cash: 4_013_999_606n };

const CASH = (n: number) => BigInt(Math.round(n * 1e6));
const pad = (s: string | number, n: number) => String(s).padStart(n);

/** Asset Hub's execution fee on the off-ramp's remote sale, in CASH. */
const AH_EXEC_FEE_CASH = ASSET_HUB_FEE_BUFFER_CASH;
/** The fee PAS sizeSwap buys on Paseo, 0.1041559 PAS (ED plus the XCM fee). It costs about
 *  0.42 CASH; do not read that figure as PAS. */
const FEE_SWAP_PAS = 1_041_559_000n;

const scale = (r: { pas: bigint; cash: bigint }, m: number) => ({
  pas: (r.pas * BigInt(Math.round(m * 1000))) / 1000n,
  cash: (r.cash * BigInt(Math.round(m * 1000))) / 1000n,
});

const DEPTHS: Array<[string, number]> = [
  ["0.25x ~26k", 0.25],
  ["1x today", 1],
  ["4x ~425k", 4],
  ["24x ~2.5M", 24],
];

// Site A: N buyers at once.

/** N deposits sized at one head, then converted in order until the first stall. */
function concurrentBuys(
  reserves: OrientedReserves,
  buy: bigint,
  pct: number,
  n: number,
): { cleared: number; stalledAt: number | null } {
  const quote = amountIn(buy, reserves, FEE);
  if (quote === null) return { cleared: 0, stalledAt: 0 };
  // Everyone is quoted at the same head and asked for the same deposit.
  const deposit = (quote * BigInt(Math.round((100 + pct) * 100))) / 10_000n;

  let pool = reserves;
  for (let i = 0; i < n; i += 1) {
    const need = amountIn(buy, pool, FEE);
    if (need === null || deposit < need) return { cleared: i, stalledAt: i };
    // This buyer converts: their native goes in, their CASH comes out.
    pool = { in: pool.in + need, out: pool.out - buy };
  }
  return { cleared: n, stalledAt: null };
}

// Site B: N sellers at once.

/**
 * N withdrawals sized at one head, then sold in order. A sale under its `minPasOut` traps on
 * Asset Hub rather than getting a worse price.
 */
function concurrentSells(
  reserves: OrientedReserves,
  sellCash: bigint,
  pct: number,
  n: number,
): { landed: number; trappedAt: number | null } {
  const quoted = amountOut(sellCash, reserves, FEE);
  if (quoted === null) return { landed: 0, trappedAt: 0 };
  const minOut = (quoted * BigInt(Math.round((100 - pct) * 100))) / 10_000n;
  const sold = sellCash - AH_EXEC_FEE_CASH;

  let pool = reserves;
  for (let i = 0; i < n; i += 1) {
    const got = amountOut(sold, pool, FEE);
    if (got === null || got < minOut) return { landed: i, trappedAt: i };
    // This sale executes: CASH in, PAS out.
    pool = { in: pool.in + sold, out: pool.out - got };
  }
  return { landed: n, trappedAt: null };
}

// Site C: N fee swaps at once.

/** N withdrawals each buying the PAS their own fees need, on the same thin People pool. */
function concurrentFeeSwaps(
  reserves: OrientedReserves,
  pct: number,
  n: number,
): { swapped: number; rejectedAt: number | null } {
  const quote = amountIn(FEE_SWAP_PAS, reserves, FEE);
  if (quote === null) return { swapped: 0, rejectedAt: 0 };
  const cashInMax = (quote * BigInt(Math.round((100 + pct) * 100))) / 10_000n;

  let pool = reserves;
  for (let i = 0; i < n; i += 1) {
    const cost = amountIn(FEE_SWAP_PAS, pool, FEE);
    if (cost === null || cost > cashInMax) return { swapped: i, rejectedAt: i };
    pool = { in: pool.in + cost, out: pool.out - FEE_SWAP_PAS };
  }
  return { swapped: n, rejectedAt: null };
}

/** The largest N that survives, by bisection on the outcome. */
function capacity(run: (n: number) => boolean, limit = 4096): number {
  if (!run(1)) return 0;
  let lo = 1;
  let hi = limit;
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    if (run(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

describe("several of our own requests in flight at once", () => {
  it("site A: the shipped crypto headroom clears the queue it is sized for, and less stalls sooner", () => {
    // A stall is a delay, not a loss: the buyer keeps the deposit and waits for the price.
    const reserves: OrientedReserves = { in: AH.pas, out: AH.cash };
    const queue = ADVERSE_FLOW_MULTIPLE.minutes;
    const pct = headroomFor({
      reserves,
      buyTarget: CASH(100),
      exposure: "minutes",
      feePpm: FEE,
    }).pct;
    expect(concurrentBuys(reserves, CASH(100), pct, queue).stalledAt).toBeNull();
    expect(concurrentBuys(reserves, CASH(100), 0.5, queue).stalledAt).not.toBeNull();
  });

  it("site B: a tighter bound traps an earlier sale in the queue", () => {
    const reserves: OrientedReserves = { in: AH.cash, out: AH.pas };
    const fits = (pct: number) =>
      capacity((n) => concurrentSells(reserves, CASH(100), pct, n).trappedAt === null);
    const tight = fits(0.5);
    const shipped = fits(5);
    expect(tight).toBeLessThan(shipped);
    expect(shipped).toBeGreaterThan(10);
  });

  it("site C: at the fee swap's 5% floor more than twenty withdrawals fit on People", () => {
    const reserves: OrientedReserves = { in: PE.cash, out: PE.pas };
    const fits = (pct: number) =>
      capacity((n) => concurrentFeeSwaps(reserves, pct, n).rejectedAt === null);
    expect(fits(5)).toBeGreaterThan(fits(0.5));
    // The fee swap never ships below SWAP_HEADROOM_PCT, 5%.
    expect(fits(5)).toBeGreaterThan(20);
  });

  it("a deeper pool carries a longer queue at the same bound", () => {
    const at = (m: number) => {
      const r = scale(AH, m);
      return capacity(
        (n) => concurrentSells({ in: r.cash, out: r.pas }, CASH(100), 5, n).trappedAt === null,
      );
    };
    expect(at(4)).toBeGreaterThan(at(1));
    expect(at(24)).toBeGreaterThan(at(4));
  });

  if (REPORT) {
    it("report", () => {
      say("\n═══ HOW MANY OF OUR OWN REQUESTS FIT INSIDE EACH BOUND ═══");
      say("  (all quoted against one head, then executed in order)\n");

      const bounds = [0.25, 0.5, 1, 2, 5, 10];

      for (const [name, m] of DEPTHS) {
        const r = scale(AH, m);
        say(`\n  --- SITE B, off-ramp, 100 CASH withdrawals, pool ${name} ---`);
        say(`  ${pad("bound", 10)}${pad("queue survives", 16)}${pad("value", 14)}`);
        const sellRes: OrientedReserves = { in: r.cash, out: r.pas };
        for (const b of bounds) {
          const fits = capacity(
            (n) => concurrentSells(sellRes, CASH(100), b, n).trappedAt === null,
          );
          say(`  ${pad(`${b}%`, 10)}${pad(String(fits), 16)}`);
        }
        const quoted = amountOut(CASH(100), sellRes, FEE);
        if (quoted !== null) {
          // What the off-ramp ships for this sale: saleBounds with the 5% ceiling.
          const pct = saleBounds({
            reserves: sellRes,
            quoted,
            cashOnKey: CASH(100),
            ceilingPct: 5,
            feePpm: FEE,
          }).safetyPct;
          const fits = capacity(
            (n) => concurrentSells(sellRes, CASH(100), pct, n).trappedAt === null,
          );
          say(`  ${pad("shipped", 10)}${pad(String(fits), 16)}${pad(`${pct.toFixed(2)}%`, 14)}`);
        }
      }

      say(`\n  --- SITE C, fee swaps on the People pool (the thin one) ---`);
      say(`  ${pad("bound", 10)}${pad("queue survives", 16)}`);
      const feeRes: OrientedReserves = { in: PE.cash, out: PE.pas };
      for (const b of bounds) {
        const fits = capacity((n) => concurrentFeeSwaps(feeRes, b, n).rejectedAt === null);
        say(`  ${pad(`${b}%`, 10)}${pad(String(fits), 16)}`);
      }
      // What the fee swap ships, from swapHeadroomPct.
      const pctC = swapHeadroomPct({ cash: feeRes.in, pas: feeRes.out }, FEE_SWAP_PAS);
      say(
        `  ${pad("shipped", 10)}${pad(String(capacity((n) => concurrentFeeSwaps(feeRes, pctC, n).rejectedAt === null)), 16)}${pad(`${pctC.toFixed(2)}%`, 14)}`,
      );

      say(`\n  --- SITE A, on-ramp, 100 CASH buys, pool 1x today ---`);
      say(`  ${pad("bound", 10)}${pad("queue clears", 14)}   (a stall is a wait, not a loss)`);
      const buyRes: OrientedReserves = { in: AH.pas, out: AH.cash };
      for (const b of bounds) {
        const fits = capacity((n) => concurrentBuys(buyRes, CASH(100), b, n).stalledAt === null);
        say(`  ${pad(`${b}%`, 10)}${pad(String(fits), 14)}`);
      }
      const floor = derivedFloorPct({
        reserves: buyRes,
        tradeOut: CASH(100),
        competingTrade: CASH(100),
        feePpm: FEE,
      });
      say(
        `\n  derived floor on this pool: ${floor.pct}%  (fee ${floor.feePct.toFixed(4)}%, competition ${floor.competitionPct.toFixed(4)}%)`,
      );
    });
  }
});
