// Runs each headroom site against a mocked pool that keeps moving while the request waits.
//
// ACCEPTANCE_REPORT=1 pnpm vitest run tests/slippage-acceptance.test.ts prints the tables.

import { describe, expect, it } from "vitest";
import {
  amountIn,
  amountOut,
  slippageFor,
  DEFAULT_SLIPPAGE_PCT,
  type Exposure,
  type OrientedReserves,
} from "@getsome/funding";
import {
  ASSET_HUB_FEE_BUFFER_CASH,
  DEFAULT_WITHDRAW_SLIPPAGE_PCT,
  SWAP_HEADROOM_PCT,
  swapHeadroomPct,
} from "@getsome/withdraw";

const FEE = 3_000n;
const REPORT = process.env.ACCEPTANCE_REPORT === "1";
const say = (...a: unknown[]) => {
  if (REPORT) console.log(...a);
};

/** Asset Hub as measured on 2026-09-22. */
const AH = { pas: 411_831_067_975_701n, cash: 106_378_021_598n };
/** People as measured the same day. */
const PE = { pas: 9_965_227_563_804n, cash: 4_013_999_606n };

const CASH = (n: number) => BigInt(Math.round(n * 1e6));
const PAS = (n: number) => BigInt(Math.round(n * 1e10));
const pad = (s: string | number, n: number) => String(s).padStart(n);

/** Asset Hub's execution fee on the sale, in CASH: the gap minPasOut has to clear. */
const AH_EXEC_FEE_CASH = ASSET_HUB_FEE_BUFFER_CASH;

/** A pool somebody else is trading against while we wait. */
class DriftingPool {
  constructor(
    public reserves: OrientedReserves,
    readonly feePpm = FEE,
  ) {}

  /** Somebody takes `flowOut` of the out-asset: the price moves against us. */
  adverse(flowOut: bigint): boolean {
    if (flowOut <= 0n) return true;
    const paid = amountIn(flowOut, this.reserves, this.feePpm);
    if (paid === null) return false;
    this.reserves = { in: this.reserves.in + paid, out: this.reserves.out - flowOut };
    return true;
  }

  /** Somebody sells the out-asset in: the price moves in our favour. */
  favourable(flowOut: bigint): boolean {
    if (flowOut <= 0n) return true;
    const got = amountOut(flowOut, { in: this.reserves.out, out: this.reserves.in }, this.feePpm);
    if (got === null || got >= this.reserves.in) return false;
    this.reserves = { in: this.reserves.in - got, out: this.reserves.out + flowOut };
    return true;
  }

  /** Net flow: positive is adverse, negative is favourable. */
  drift(flowOut: bigint): boolean {
    return flowOut >= 0n ? this.adverse(flowOut) : this.favourable(-flowOut);
  }

  costOf(out: bigint): bigint | null {
    return amountIn(out, this.reserves, this.feePpm);
  }
  proceedsOf(input: bigint): bigint | null {
    return amountOut(input, this.reserves, this.feePpm);
  }
  clone(): DriftingPool {
    return new DriftingPool({ ...this.reserves }, this.feePpm);
  }
}

/** A deterministic LCG, scrambled and warmed up so nearby seeds do not start alike. */
function lcg(seed: number) {
  let s = (seed * 2_654_435_761) >>> 0;
  const step = () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 4_294_967_296;
  };
  for (let i = 0; i < 8; i += 1) step();
  return step;
}

/** Assumed third-party flow per exposure class, in typical 100 CASH trades. */
const FLOW_BAND: Record<Exposure, { trades: number[]; label: string }> = {
  instant: { trades: [0, 0.5, 1, 2, 4], label: "one tick (~6s) to one block window" },
  minutes: { trades: [0, 2, 5, 10, 20], label: "a crypto deposit, minutes" },
  hours: { trades: [0, 5, 15, 30, 60], label: "a card purchase, hours" },
  days: { trades: [0, 10, 30, 75, 150], label: "a bank transfer, up to 3 days" },
};

/** A headroom strategy. `pctFor` sees only the pool at sizing time, like the real code. */
type Strategy = {
  name: string;
  pctFor(r: OrientedReserves, tradeOut: bigint, e: Exposure, reference: bigint): number;
};

// A: the on-ramp's headroom when the pool cannot be read. B: the off-ramp's 5% ceiling.
const SHIPPED_A = DEFAULT_SLIPPAGE_PCT;
const SHIPPED_B = DEFAULT_WITHDRAW_SLIPPAGE_PCT;
/** The fee PAS sizeSwap buys on Paseo, 0.1041559 PAS (ED plus the XCM fee). It costs about
 *  0.42 CASH; do not read that figure as PAS. */
const FEE_SWAP_PAS = 1_041_559_000n;
/** What the fee swap ships on the measured People pool. */
const SHIPPED_C = swapHeadroomPct({ cash: PE.cash, pas: PE.pas }, FEE_SWAP_PAS);

const strategies = (shipped: number): Strategy[] => [
  { name: `shipped ${shipped}%`, pctFor: () => shipped },
  {
    name: "slippageFor alone",
    pctFor: (r, tradeOut, e, reference) =>
      slippageFor({ reserves: r, tradeOut, exposure: e, referenceTrade: reference, feePpm: FEE })
        .pct,
  },
  {
    name: "slippageFor, floor at 5%",
    pctFor: (r, tradeOut, e, reference) =>
      Math.max(
        shipped,
        slippageFor({ reserves: r, tradeOut, exposure: e, referenceTrade: reference, feePpm: FEE })
          .pct,
      ),
  },
];

type SiteAOutcome = "cleared" | "waited-then-cleared" | "expired";

/**
 * Site A, the on-ramp. Sizes the deposit, drifts the pool for the exposure window, then ticks the
 * gate (as decideStep: plain quote plus fee native) until it clears or runs out. A breach rolls
 * back, so it costs a wait, never funds.
 */
function runSiteA(input: {
  pool: DriftingPool;
  buy: bigint;
  keepNative: bigint;
  pct: number;
  driftDuringWindow: bigint;
  /** Signed drift per tick after delivery. */
  driftPerTick: () => bigint;
  ticks: number;
}): { outcome: SiteAOutcome; ticksWaited: number; deposit: bigint; overPaidPct: number } {
  const sizingQuote = input.pool.costOf(input.buy);
  if (sizingQuote === null)
    return { outcome: "expired", ticksWaited: 0, deposit: 0n, overPaidPct: 0 };
  const deposit =
    (sizingQuote * BigInt(Math.round((100 + input.pct) * 100))) / 10_000n + input.keepNative;

  input.pool.drift(input.driftDuringWindow);

  for (let t = 0; t <= input.ticks; t += 1) {
    const needNow = input.pool.costOf(input.buy);
    if (needNow !== null && deposit >= needNow + input.keepNative) {
      const over = (Number(deposit - input.keepNative - needNow) / Number(needNow)) * 100;
      return {
        outcome: t === 0 ? "cleared" : "waited-then-cleared",
        ticksWaited: t,
        deposit,
        overPaidPct: over,
      };
    }
    input.pool.drift(input.driftPerTick());
  }
  return { outcome: "expired", ticksWaited: input.ticks, deposit, overPaidPct: 0 };
}

type SiteBOutcome =
  /** The remote exchange cleared and the PAS reached the destination. */
  | "landed"
  /** The dry run refused before the submit: free, but the next tick recomputes the same value. */
  | "refused-at-sizing"
  /** The exchange failed on Asset Hub and the assets are trapped there for the claimer. */
  | "trapped";

/**
 * Site B, the off-ramp sale. The dry run is modelled on the same reserves as the quote (both read
 * the best head), so it catches only the fee gap. The price then moves during inclusion and the
 * XCMP hop, and a breach traps with no rollback.
 */
function runSiteB(input: {
  pool: DriftingPool;
  cashOnKey: bigint;
  pct: number;
  driftBeforeInclusion: bigint;
  driftDuringHop: bigint;
}): { outcome: SiteBOutcome; minPasOut: bigint; actual: bigint } {
  const quoted = input.pool.proceedsOf(input.cashOnKey);
  if (quoted === null) return { outcome: "refused-at-sizing", minPasOut: 0n, actual: 0n };
  const minPasOut = (quoted * BigInt(Math.round((100 - input.pct) * 100))) / 10_000n;

  // The dry run, on the same reserves: it sells everything but Asset Hub's fee.
  const sold = input.cashOnKey - AH_EXEC_FEE_CASH;
  const dryRun = input.pool.proceedsOf(sold);
  if (dryRun === null || dryRun < minPasOut) {
    return { outcome: "refused-at-sizing", minPasOut, actual: dryRun ?? 0n };
  }

  // Now time passes, and nothing checks the price again.
  input.pool.drift(input.driftBeforeInclusion);
  input.pool.drift(input.driftDuringHop);

  const actual = input.pool.proceedsOf(sold);
  if (actual === null || actual < minPasOut) {
    return { outcome: "trapped", minPasOut, actual: actual ?? 0n };
  }
  return { outcome: "landed", minPasOut, actual };
}

type SiteCOutcome = "swapped" | "refused-too-small" | "rejected" | "out-of-strikes";

/**
 * Site C, the People fee swap: size, wait a tick, submit with no dry run. A breach burns a CASH
 * fee and one of the three strikes shared with the XCM.
 */
function runSiteC(input: {
  pool: DriftingPool;
  pasNeeded: bigint;
  cashBalance: bigint;
  pct: number;
  driftPerTick: () => bigint;
  strikes?: number;
}): { outcome: SiteCOutcome; strikesUsed: number; paid: bigint } {
  const maxStrikes = input.strikes ?? 3;
  for (let strike = 0; strike < maxStrikes; strike += 1) {
    const quoted = input.pool.costOf(input.pasNeeded);
    if (quoted === null) return { outcome: "rejected", strikesUsed: strike + 1, paid: 0n };
    const cashInMax = (quoted * BigInt(Math.round((100 + input.pct) * 100))) / 10_000n;
    // Like sizeSwap, refuse on the ceiling with its headroom, not on what the swap will spend.
    if (cashInMax >= input.cashBalance) {
      return { outcome: "refused-too-small", strikesUsed: strike, paid: 0n };
    }
    input.pool.drift(input.driftPerTick());
    const costNow = input.pool.costOf(input.pasNeeded);
    if (costNow !== null && costNow <= cashInMax) {
      return { outcome: "swapped", strikesUsed: strike, paid: costNow };
    }
  }
  return { outcome: "out-of-strikes", strikesUsed: maxStrikes, paid: 0n };
}

const typical = CASH(100);

describe("site A, on-ramp: a moving pool while the rail delivers", () => {
  const exposures: Exposure[] = ["minutes", "hours", "days"];

  it("the shipped 5% clears the 'days' band up to the flow it absorbs", () => {
    // 5% absorbs about 25 typical trades of adverse flow on this pool.
    const inside = [0, 10, 25];
    for (const trades of inside) {
      const pool = new DriftingPool({ in: AH.pas, out: AH.cash });
      const out = runSiteA({
        pool,
        buy: typical,
        keepNative: PAS(0.04),
        pct: SHIPPED_A,
        driftDuringWindow: CASH(100 * trades),
        driftPerTick: () => 0n,
        ticks: 0,
      });
      expect(out.outcome).toBe("cleared");
    }
  });

  it("a stalled deposit is rescued by a favourable drift inside the deposit window", () => {
    // The gate re-quotes every tick, so a breach at site A is a wait, not a loss.
    const pool = new DriftingPool({ in: AH.pas, out: AH.cash });
    const out = runSiteA({
      pool,
      buy: typical,
      keepNative: PAS(0.04),
      pct: SHIPPED_A,
      driftDuringWindow: CASH(100 * 75), // past the headroom
      driftPerTick: () => -CASH(400), // the pool comes back
      ticks: 60,
    });
    expect(out.outcome).toBe("waited-then-cleared");
    expect(out.ticksWaited).toBeGreaterThan(0);
  });

  if (REPORT) {
    it("report", () => {
      say("\n═══ SITE A: deposit sized at t0, pool drifts, gate checked at delivery ═══");
      for (const exposure of exposures) {
        say(`\n  exposure=${exposure}  (${FLOW_BAND[exposure].label})`);
        say(
          `  ${pad("strategy", 26)}${pad("pct", 7)}  ` +
            FLOW_BAND[exposure].trades.map((t) => pad(`${t}x`, 12)).join(""),
        );
        for (const s of strategies(SHIPPED_A)) {
          const base = new DriftingPool({ in: AH.pas, out: AH.cash });
          const pct = s.pctFor(base.reserves, typical, exposure, typical);
          const cells = FLOW_BAND[exposure].trades.map((trades) => {
            const pool = new DriftingPool({ in: AH.pas, out: AH.cash });
            const out = runSiteA({
              pool,
              buy: typical,
              keepNative: PAS(0.04),
              pct,
              driftDuringWindow: CASH(100 * trades),
              driftPerTick: () => 0n,
              ticks: 0,
            });
            return pad(out.outcome === "cleared" ? `+${out.overPaidPct.toFixed(1)}%` : "WAIT", 12);
          });
          say(`  ${pad(s.name, 26)}${pad(pct.toFixed(2), 7)}  ${cells.join("")}`);
        }
      }
    });
  }
});

describe("site B, off-ramp: the dry run cannot see the move that matters", () => {
  it("the structural gap, and only it, is what the dry run refuses", () => {
    // Asset Hub's fee comes out of the sale, so a headroom below fee / cashOnKey never passes.
    const tiny = CASH(0.5);
    const gapPct = (Number(AH_EXEC_FEE_CASH) / Number(tiny)) * 100;
    const below = new DriftingPool({ in: AH.cash, out: AH.pas });
    expect(
      runSiteB({
        pool: below,
        cashOnKey: tiny,
        pct: gapPct / 4,
        driftBeforeInclusion: 0n,
        driftDuringHop: 0n,
      }).outcome,
    ).toBe("refused-at-sizing");
    const above = new DriftingPool({ in: AH.cash, out: AH.pas });
    expect(
      runSiteB({
        pool: above,
        cashOnKey: tiny,
        pct: gapPct * 3,
        driftBeforeInclusion: 0n,
        driftDuringHop: 0n,
      }).outcome,
    ).toBe("landed");
  });

  it("an adverse move after inclusion traps the withdrawal, with no retry", () => {
    // The tick loop cannot recover from this; only the claimer can.
    const pool = new DriftingPool({ in: AH.cash, out: AH.pas });
    const out = runSiteB({
      pool,
      cashOnKey: typical,
      pct: 0.5,
      driftBeforeInclusion: PAS(300),
      driftDuringHop: PAS(300),
    });
    expect(out.outcome).toBe("trapped");
    expect(out.actual).toBeLessThan(out.minPasOut);
  });

  it("a tighter headroom traps at strictly less flow", () => {
    const trapAt = (pct: number) => {
      for (const pasFlow of [1, 5, 10, 25, 50, 100, 200, 400, 800, 1600]) {
        const pool = new DriftingPool({ in: AH.cash, out: AH.pas });
        const out = runSiteB({
          pool,
          cashOnKey: typical,
          pct,
          driftBeforeInclusion: PAS(pasFlow),
          driftDuringHop: 0n,
        });
        if (out.outcome === "trapped") return pasFlow;
      }
      return Infinity;
    };
    const tight = trapAt(0.5);
    const shipped = trapAt(SHIPPED_B);
    expect(tight).toBeLessThan(shipped);
  });

  if (REPORT) {
    it("report", () => {
      say("\n═══ SITE B: sized at t0, price moves during inclusion + XCMP hop ═══");
      say("  (the dry run sees neither move: it runs against the sizing head)");
      const flows = [0, 25, 50, 100, 200, 400, 800];
      say(
        `\n  ${pad("strategy", 26)}${pad("pct", 7)}${pad("guarantee gap", 15)}  ` +
          flows.map((f) => pad(`${f} PAS`, 10)).join(""),
      );
      for (const s of strategies(SHIPPED_B)) {
        const base = new DriftingPool({ in: AH.cash, out: AH.pas });
        const quoted = base.proceedsOf(typical)!;
        const pct = s.pctFor(base.reserves, quoted, "instant", PAS(38.5));
        const cells = flows.map((f) => {
          const pool = new DriftingPool({ in: AH.cash, out: AH.pas });
          const out = runSiteB({
            pool,
            cashOnKey: typical,
            pct,
            driftBeforeInclusion: PAS(f),
            driftDuringHop: 0n,
          });
          return pad(
            out.outcome === "landed" ? "ok" : out.outcome === "trapped" ? "TRAPPED" : "refused",
            10,
          );
        });
        say(
          `  ${pad(s.name, 26)}${pad(pct.toFixed(2), 7)}${pad(`${pct.toFixed(2)}%`, 15)}  ${cells.join("")}`,
        );
      }
    });
  }
});

describe("site C, People fee swap: blind submit, three shared strikes", () => {
  const pasNeeded = FEE_SWAP_PAS;
  const balance = CASH(100);

  it("2% is killed by a peer buying 15 PAS each tick", () => {
    // 2% absorbs about 9.8 PAS on the People pool, so this peer uses up all three strikes.
    const pool = new DriftingPool({ in: PE.cash, out: PE.pas });
    const out = runSiteC({
      pool,
      pasNeeded,
      cashBalance: balance,
      pct: 2,
      driftPerTick: () => PAS(15),
    });
    expect(out.outcome).toBe("out-of-strikes");
  });

  it("the shipped headroom survives that same peer", () => {
    const pool = new DriftingPool({ in: PE.cash, out: PE.pas });
    const out = runSiteC({
      pool,
      pasNeeded,
      cashBalance: balance,
      pct: SHIPPED_C,
      driftPerTick: () => PAS(15),
    });
    expect(out.outcome).toBe("swapped");
  });

  it("the cost of widening is a higher minimum withdrawal, and it is small", () => {
    const minFor = (pct: number) => {
      const pool = new DriftingPool({ in: PE.cash, out: PE.pas });
      const quoted = pool.costOf(pasNeeded)!;
      return (quoted * BigInt(Math.round((100 + pct) * 100))) / 10_000n;
    };
    const at2 = minFor(2);
    const at5 = minFor(SHIPPED_C);
    expect(at5).toBeGreaterThan(at2);
    // The bar: under 0.1 CASH more on the smallest withdrawal.
    expect(Number(at5 - at2) / 1e6).toBeLessThan(0.1);
  });

  it("a headroom wide enough to refuse the balance outright is caught, not submitted", () => {
    const pool = new DriftingPool({ in: PE.cash, out: PE.pas });
    const out = runSiteC({
      pool,
      pasNeeded,
      // The fee trade costs about 0.42 CASH, so with 50% headroom the ceiling is about 0.63.
      cashBalance: CASH(0.6),
      pct: 50,
      driftPerTick: () => 0n,
    });
    expect(out.outcome).toBe("refused-too-small");
  });

  it("the computed value alone is too tight here, which is why it never ships below the constant", () => {
    // Plain slippageFor is killed by the same peer the shipped value survives.
    expect(SHIPPED_C).toBeGreaterThanOrEqual(SWAP_HEADROOM_PCT);
    const pool = new DriftingPool({ in: PE.cash, out: PE.pas });
    const pct = slippageFor({
      reserves: pool.reserves,
      tradeOut: pasNeeded,
      exposure: "instant",
      feePpm: FEE,
    }).pct;
    const run = runSiteC({
      pool: pool.clone(),
      pasNeeded,
      cashBalance: balance,
      pct,
      driftPerTick: () => PAS(15),
    });
    expect(run.outcome).toBe("out-of-strikes");
  });

  if (REPORT) {
    it("report", () => {
      say("\n═══ SITE C: People fee swap, blind submit, peer flow per tick ═══");
      const flows = [0, 2, 5, 10, 15, 30, 60];
      say(
        `\n  ${pad("pct", 8)}${pad("min withdrawal", 18)}  ` +
          flows.map((f) => pad(`${f} PAS`, 11)).join(""),
      );
      for (const pct of [0.25, 1, 2, 5, 10]) {
        const q = new DriftingPool({ in: PE.cash, out: PE.pas }).costOf(pasNeeded)!;
        const minW = (q * BigInt(Math.round((100 + pct) * 100))) / 10_000n;
        const cells = flows.map((f) => {
          const pool = new DriftingPool({ in: PE.cash, out: PE.pas });
          const out = runSiteC({
            pool,
            pasNeeded,
            cashBalance: balance,
            pct,
            driftPerTick: () => PAS(f),
          });
          return pad(
            out.outcome === "swapped"
              ? "ok"
              : out.outcome === "out-of-strikes"
                ? "KILLED"
                : out.outcome,
            11,
          );
        });
        say(
          `  ${pad(`${pct}%`, 8)}${pad(`${(Number(minW) / 1e6).toFixed(6)} CASH`, 18)}  ${cells.join("")}`,
        );
      }
    });
  }
});

describe("a two-sided random walk, which is what real flow looks like", () => {
  // The pool wanders both ways, and each test asserts what must hold whatever it does.
  const walk = (rand: () => number, scale: bigint) => () =>
    BigInt(Math.round((rand() - 0.5) * 2 * Number(scale)));

  it("site B traps more often when tighter, and at the shipped headroom on under half the walks", () => {
    const trapRate = (pct: number) => {
      let trapped = 0;
      for (let seed = 1; seed <= 200; seed += 1) {
        const rand = lcg(seed);
        const pool = new DriftingPool({ in: AH.cash, out: AH.pas });
        const out = runSiteB({
          pool,
          cashOnKey: typical,
          pct,
          driftBeforeInclusion: walk(rand, PAS(400))(),
          driftDuringHop: walk(rand, PAS(400))(),
        });
        if (out.outcome === "trapped") trapped += 1;
      }
      return trapped / 200;
    };
    const tight = trapRate(0.5);
    const shipped = trapRate(SHIPPED_B);
    say(
      `\n  site B trap rate over 200 walks: 0.5% -> ${(tight * 100).toFixed(1)}%,` +
        ` ${SHIPPED_B}% -> ${(shipped * 100).toFixed(1)}%`,
    );
    expect(tight).toBeGreaterThan(shipped);
    expect(shipped).toBeLessThan(0.5);
  });

  it("site C is killed more often the tighter it is", () => {
    const killRate = (pct: number) => {
      let killed = 0;
      for (let seed = 1; seed <= 200; seed += 1) {
        const rand = lcg(seed);
        const pool = new DriftingPool({ in: PE.cash, out: PE.pas });
        const out = runSiteC({
          pool,
          pasNeeded: FEE_SWAP_PAS,
          cashBalance: CASH(100),
          pct,
          driftPerTick: walk(rand, PAS(20)),
        });
        if (out.outcome === "out-of-strikes") killed += 1;
      }
      return killed / 200;
    };
    const tight = killRate(0.25);
    const wide = killRate(5);
    say(
      `  site C kill rate over 200 walks: 0.25% -> ${(tight * 100).toFixed(1)}%,` +
        ` 5% -> ${(wide * 100).toFixed(1)}%`,
    );
    expect(tight).toBeGreaterThan(wide);
  });
});
