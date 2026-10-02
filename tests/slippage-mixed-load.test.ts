// Seeded mixes of buys and withdrawals, sized at one head, then executed in order. Each withdrawal
// also buys its fee PAS on the People pool.
//
//   MIXED_REPORT=1 pnpm vitest run tests/slippage-mixed-load.test.ts   # prints the tables

import { describe, expect, it } from "vitest";
import { amountIn, amountOut, DIRECT_SLIPPAGE_PCT, type OrientedReserves } from "@getsome/funding";
import {
  ASSET_HUB_FEE_BUFFER_CASH,
  DEFAULT_WITHDRAW_SLIPPAGE_PCT,
  saleBounds,
  swapHeadroomPct,
} from "@getsome/withdraw";

const FEE = 3_000n;
const REPORT = process.env.MIXED_REPORT === "1";
const say = (...a: unknown[]) => {
  if (REPORT) console.log(...a);
};

/** Asset Hub and People as measured 2026-09-25. */
const AH = { pas: 421_298_658_000_000n, cash: 103_995_360_000n };
const PE = { pas: 9_957_996_000_000n, cash: 4_016_920_000n };

const CASH = (n: number) => BigInt(Math.round(n * 1e6));
const pad = (s: string | number, n: number) => String(s).padStart(n);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** Asset Hub's execution fee on the sale, in CASH. */
const AH_EXEC_FEE_CASH = ASSET_HUB_FEE_BUFFER_CASH;
/** The fee PAS sizeSwap buys on Paseo, 0.1041559 PAS (ED plus the XCM fee). It costs about
 *  0.42 CASH; do not read that figure as PAS. */
const FEE_SWAP_PAS = 1_041_559_000n;

const scale = (r: { pas: bigint; cash: bigint }, m: number) => ({
  pas: (r.pas * BigInt(Math.round(m * 1000))) / 1000n,
  cash: (r.cash * BigInt(Math.round(m * 1000))) / 1000n,
});

/** A deterministic LCG, scrambled and warmed up so nearby seeds do not start alike. */
function rng(seed: number) {
  let s = (seed * 2_654_435_761) >>> 0;
  const step = () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 4_294_967_296;
  };
  for (let i = 0; i < 8; i += 1) step();
  return step;
}

/** A spread of request sizes around the typical one, in CASH. */
function sizeFrom(r: () => number): bigint {
  const choices = [5, 20, 50, 100, 200, 500];
  return CASH(choices[Math.floor(r() * choices.length)] ?? 100);
}

/** Both pools. Asset Hub is held as the on-ramp sees it: PAS in, CASH out. */
class World {
  constructor(
    public ah: OrientedReserves,
    public people: OrientedReserves,
  ) {}

  /** The off-ramp's view of Asset Hub: CASH paid, PAS received. */
  get sale(): OrientedReserves {
    return { in: this.ah.out, out: this.ah.in };
  }

  /** An on-ramp conversion: PAS in, CASH out. Returns what it cost, or null if it cannot clear. */
  buy(cashOut: bigint): bigint | null {
    const paid = amountIn(cashOut, this.ah, FEE);
    if (paid === null) return null;
    this.ah = { in: this.ah.in + paid, out: this.ah.out - cashOut };
    return paid;
  }

  /** An off-ramp sale: CASH in, PAS out. */
  sell(cashIn: bigint): bigint | null {
    const got = amountOut(cashIn, this.sale, FEE);
    if (got === null || got >= this.ah.in) return null;
    this.ah = { in: this.ah.in - got, out: this.ah.out + cashIn };
    return got;
  }

  /** A fee swap on People: CASH in, an exact PAS out. */
  feeSwap(pasOut: bigint): bigint | null {
    const cost = amountIn(pasOut, this.people, FEE);
    if (cost === null) return null;
    this.people = { in: this.people.in + cost, out: this.people.out - pasOut };
    return cost;
  }
}

type Request = { kind: "buy"; cash: bigint } | { kind: "withdraw"; cash: bigint };

type Result =
  | { kind: "buy"; outcome: "cleared" | "stalled"; overPaid: number }
  | { kind: "withdraw"; outcome: "landed" | "trapped" | "fee-rejected" };

/** Sizes every request at the current head, then executes them in order. */
function runPass(world: World, requests: Request[]): Result[] {
  const sized = requests.map((r) => {
    if (r.kind === "buy") {
      // Buys are crypto deposits, asked with the fixed headroom as production does.
      const quote = amountIn(r.cash, world.ah, FEE);
      const deposit =
        quote === null
          ? 0n
          : (quote * BigInt(Math.round((100 + DIRECT_SLIPPAGE_PCT) * 100))) / 10_000n;
      return { req: r, deposit };
    }
    const quoted = amountOut(r.cash, world.sale, FEE) ?? 0n;
    // Withdrawals use the production saleBounds and swapHeadroomPct.
    const bounds = saleBounds({
      reserves: world.sale,
      quoted,
      cashOnKey: r.cash,
      ceilingPct: DEFAULT_WITHDRAW_SLIPPAGE_PCT,
      feePpm: FEE,
    });
    const feeQuote = amountIn(FEE_SWAP_PAS, world.people, FEE) ?? 0n;
    const feePct = swapHeadroomPct({ cash: world.people.in, pas: world.people.out }, FEE_SWAP_PAS);
    const cashInMax = (feeQuote * BigInt(Math.round((100 + feePct) * 100))) / 10_000n;
    return { req: r, quoted, bounds, cashInMax };
  });

  // Execute in order, each against the pools the earlier ones moved.
  return sized.map((s): Result => {
    if (s.req.kind === "buy") {
      const need = amountIn(s.req.cash, world.ah, FEE);
      if (need === null || (s as { deposit: bigint }).deposit < need) {
        return { kind: "buy", outcome: "stalled", overPaid: 0 };
      }
      world.buy(s.req.cash);
      const deposit = (s as { deposit: bigint }).deposit;
      return { kind: "buy", outcome: "cleared", overPaid: Number(deposit - need) / Number(need) };
    }
    const t = s as {
      quoted: bigint;
      bounds: ReturnType<typeof saleBounds>;
      cashInMax: bigint;
    };
    // The fee swap runs first, on People, with the cashInMax sized at the shared head.
    const feeCost = amountIn(FEE_SWAP_PAS, world.people, FEE);
    if (feeCost === null || feeCost > t.cashInMax)
      return { kind: "withdraw", outcome: "fee-rejected" };
    world.feeSwap(FEE_SWAP_PAS);
    // Then the sale on Asset Hub, which traps below the safety floor.
    const sold = s.req.cash - AH_EXEC_FEE_CASH;
    const got = amountOut(sold, world.sale, FEE);
    const floor = (t.quoted * BigInt(Math.round((100 - t.bounds.safetyPct) * 100))) / 10_000n;
    if (got === null || got < floor) return { kind: "withdraw", outcome: "trapped" };
    world.sell(sold);
    return { kind: "withdraw", outcome: "landed" };
  });
}

const count = (rs: Result[], o: string) =>
  rs.filter((r) => (r as { outcome: string }).outcome === o).length;

const DEPTHS: Array<[string, number]> = [
  ["0.25x", 0.25],
  ["1x today", 1],
  ["4x", 4],
  ["24x ~2.5M", 24],
];

describe("mixed load across both pools", () => {
  it("buys and sells partly cancel, so a mixed queue is gentler than a one-way one", () => {
    const oneWay = new World({ in: AH.pas, out: AH.cash }, { in: PE.cash, out: PE.pas });
    const mixed = new World({ in: AH.pas, out: AH.cash }, { in: PE.cash, out: PE.pas });
    const n = 12;
    const allBuys: Request[] = Array.from({ length: n }, () => ({
      kind: "buy",
      cash: CASH(100),
    }));
    const half: Request[] = Array.from({ length: n }, (_, i) =>
      i % 2 === 0 ? { kind: "buy", cash: CASH(100) } : { kind: "withdraw", cash: CASH(100) },
    );
    runPass(oneWay, allBuys);
    runPass(mixed, half);
    const drift = (w: World) => Math.abs(Number(w.ah.out - AH.cash) / Number(AH.cash));
    expect(drift(mixed)).toBeLessThan(drift(oneWay));
  });

  it("a withdrawal trades on both pools: PAS leaves People and CASH enters Asset Hub", () => {
    const w = new World({ in: AH.pas, out: AH.cash }, { in: PE.cash, out: PE.pas });
    const before = w.people.out;
    runPass(
      w,
      Array.from({ length: 10 }, () => ({ kind: "withdraw", cash: CASH(100) }) as Request),
    );
    expect(w.people.out).toBeLessThan(before);
    expect(w.ah.out).toBeGreaterThan(AH.cash);
  });

  it("no withdrawal traps under a mixed load at today's depth or deeper", () => {
    // 0.25x is left out: some sales trap there even at the 5% ceiling.
    for (const [, m] of DEPTHS.filter(([n]) => n !== "0.25x")) {
      for (let seed = 1; seed <= 40; seed += 1) {
        const r = rng(seed);
        const a = scale(AH, m);
        const p = scale(PE, m);
        const w = new World({ in: a.pas, out: a.cash }, { in: p.cash, out: p.pas });
        const reqs: Request[] = Array.from({ length: 8 }, () =>
          r() < 0.5 ? { kind: "buy", cash: sizeFrom(r) } : { kind: "withdraw", cash: sizeFrom(r) },
        );
        const out = runPass(w, reqs);
        expect(count(out, "trapped")).toBe(0);
      }
    }
  });

  it("the fee swap accepts eight withdrawals against one head at today's depth or deeper", () => {
    for (const [, m] of DEPTHS.filter(([n]) => n !== "0.25x")) {
      const a = scale(AH, m);
      const p = scale(PE, m);
      const w = new World({ in: a.pas, out: a.cash }, { in: p.cash, out: p.pas });
      const out = runPass(
        w,
        Array.from({ length: 8 }, () => ({ kind: "withdraw", cash: CASH(100) }) as Request),
      );
      expect(count(out, "fee-rejected")).toBe(0);
    }
  });

  if (REPORT) {
    it("report", () => {
      say("\n═══ MIXED LOAD, 8 REQUESTS PER PASS, 200 SEEDS ═══\n");
      say(
        `  ${pad("pool", 12)}${pad("cleared", 10)}${pad("stalled", 10)}${pad("landed", 9)}${pad("TRAPPED", 10)}${pad("fee rej", 9)}`,
      );
      for (const [name, m] of DEPTHS) {
        const tally = {
          cleared: 0,
          stalled: 0,
          landed: 0,
          trapped: 0,
          "fee-rejected": 0,
        };
        for (let seed = 1; seed <= 200; seed += 1) {
          const r = rng(seed);
          const a = scale(AH, m);
          const p = scale(PE, m);
          const w = new World({ in: a.pas, out: a.cash }, { in: p.cash, out: p.pas });
          const reqs: Request[] = Array.from({ length: 8 }, () =>
            r() < 0.5
              ? { kind: "buy", cash: sizeFrom(r) }
              : { kind: "withdraw", cash: sizeFrom(r) },
          );
          for (const o of runPass(w, reqs)) {
            tally[(o as { outcome: keyof typeof tally }).outcome] += 1;
          }
        }
        const total = Object.values(tally).reduce((a, b) => a + b, 0);
        say(
          `  ${pad(name, 12)}${pad(pct(tally.cleared / total), 10)}${pad(pct(tally.stalled / total), 10)}` +
            `${pad(pct(tally.landed / total), 9)}` +
            `${pad(pct(tally.trapped / total), 10)}${pad(pct(tally["fee-rejected"] / total), 9)}`,
        );
      }

      say("\n═══ ONE-WAY versus MIXED, how far the pool drifts ═══\n");
      say(`  ${pad("load", 22)}${pad("CASH side moves by", 22)}`);
      for (const [label, build] of [
        [
          "12 buys",
          () => Array.from({ length: 12 }, () => ({ kind: "buy", cash: CASH(100) }) as Request),
        ],
        [
          "12 withdrawals",
          () =>
            Array.from({ length: 12 }, () => ({ kind: "withdraw", cash: CASH(100) }) as Request),
        ],
        [
          "6 buys + 6 withdrawals",
          () =>
            Array.from(
              { length: 12 },
              (_, i) =>
                (i % 2 === 0
                  ? { kind: "buy", cash: CASH(100) }
                  : { kind: "withdraw", cash: CASH(100) }) as Request,
            ),
        ],
      ] as Array<[string, () => Request[]]>) {
        const w = new World({ in: AH.pas, out: AH.cash }, { in: PE.cash, out: PE.pas });
        runPass(w, build());
        const moved = (Number(w.ah.out - AH.cash) / Number(AH.cash)) * 100;
        say(`  ${pad(label, 22)}${pad(`${moved >= 0 ? "+" : ""}${moved.toFixed(3)}%`, 22)}`);
      }
    });
  }
});
