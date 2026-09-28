// Checks saleBounds, saleReserves and readDestinationPas, the pieces behind the sale's bound,
// against scripted answers.

import { describe, expect, it } from "vitest";
import {
  amountOut,
  MARKET_MOVE_PCT,
  withdrawalBounds,
  type OrientedReserves,
} from "@getsome/funding";
import { readDestinationPas } from "./destination";
import {
  ASSET_HUB_FEE_BUFFER_CASH,
  SALE_READ_AT,
  saleBounds,
  saleReserves,
  TYPICAL_WITHDRAWAL_CASH,
} from "./fees";

/** The live Asset Hub pool, oriented for the sale: CASH paid, PAS received. */
const SALE: OrientedReserves = { in: 103_995_360_000n, out: 421_298_658_000_000n };
/** The same price at the 2.5M CASH release depth. */
const RELEASE: OrientedReserves = { in: SALE.in * 24n, out: SALE.out * 24n };
const CASH = (n: number) => BigInt(Math.round(n * 1e6));
const FEE = 3_000n;

/** The sale's quote, from the same curve the pallet uses. */
const quoteFor = (cash: bigint, pool: OrientedReserves = SALE) => amountOut(cash, pool, FEE)!;

/** The bound sizeXcm would ship, from saleBounds itself. */
const bounds = (cash: bigint, ceilingPct: number, pool: OrientedReserves = SALE) =>
  saleBounds({
    reserves: pool,
    quoted: quoteFor(cash, pool),
    cashOnKey: cash,
    ceilingPct,
    feePpm: FEE,
  });

describe("sizeXcm's bound selection", () => {
  it("writes one floor into the program and shows the seller that same floor", () => {
    // The seller's minimum is the floor the chain enforces, so it cannot be missed.
    for (const pool of [SALE, RELEASE]) {
      const b = bounds(CASH(100), 5, pool);
      expect(b.promisePct).toBe(b.safetyPct);
    }
    expect(bounds(CASH(100), 5, RELEASE).safetyPct).toBeLessThan(5);
  });

  it("treats the caller's slippagePct as a ceiling when the pool can be read", () => {
    const cash = CASH(100);
    for (const ceiling of [0.5, 1, 5, 10]) {
      expect(bounds(cash, ceiling).safetyPct).toBeLessThanOrEqual(ceiling);
    }
  });

  it("says overCapacity whenever the ceiling cut the bound", () => {
    // Judged after the cut: a pool that asks for 6% and gets 5% is over capacity.
    for (const size of [1, 5, 20, 100, 500, 2000]) {
      const clamped = bounds(CASH(size), 5);
      const free = bounds(CASH(size), 100);
      if (free.safetyPct > clamped.safetyPct) expect(clamped.overCapacity).toBe(true);
    }
    expect(bounds(CASH(100), 0.5, RELEASE).overCapacity).toBe(true);
  });

  it("makes small withdrawals the expensive case at every depth, through Asset Hub's fee", () => {
    // Asset Hub's fee comes out of the sale first and does not shrink with the pool.
    for (const pool of [SALE, RELEASE]) {
      const small = bounds(CASH(1), 10, pool);
      const large = bounds(CASH(500), 10, pool);
      expect(small.promisePct).toBeGreaterThan(large.promisePct);
    }
  });

  it("keeps the market move on the release pool, under the 2% floor that also applies there", () => {
    // Policy floor off, since the floor alone would pass a bound with no market term.
    const cash = CASH(100);
    const quoted = quoteFor(cash, RELEASE);
    const derived = (marketMovePct?: number) =>
      withdrawalBounds({
        reserves: RELEASE,
        tradeOut: quoted,
        feeTakenFromTrade: (quoted * ASSET_HUB_FEE_BUFFER_CASH) / cash,
        referenceTrade: (quoted * TYPICAL_WITHDRAWAL_CASH) / cash,
        floorPct: 0,
        ...(marketMovePct === undefined ? {} : { marketMovePct }),
        feePpm: FEE,
      }).safetyPct;
    expect(derived()).toBeGreaterThanOrEqual(MARKET_MOVE_PCT.instant);
    expect(derived()).toBeGreaterThan(derived(0));
    expect(bounds(cash, 5, RELEASE).safetyPct).toBe(2);
  });

  it("ships the caller's ceiling when the pool cannot be read", async () => {
    // Without the view function the reserves are null and saleBounds ships the ceiling.
    const older = { view: {} } as never;
    const reserves = await saleReserves(older);
    expect(reserves).toBeNull();
    expect(
      saleBounds({ reserves, quoted: quoteFor(CASH(100)), cashOnKey: CASH(100), ceilingPct: 5 }),
    ).toEqual({ safetyPct: 5, promisePct: 5, overCapacity: false });
  });
});

describe("readDestinationPas", () => {
  it("reads at the best head, where the sale is sized", async () => {
    // The arrival check, the sweep and the refund all read here.
    const seen: unknown[][] = [];
    const api = {
      query: {
        System: {
          Account: {
            getValue: (...args: unknown[]) => {
              seen.push(args);
              return Promise.resolve({ data: { free: 42n } });
            },
          },
        },
      },
    };
    expect(await readDestinationPas(api as never, `0x${"aa".repeat(32)}`)).toBe(42n);
    expect(seen[0]![1]).toEqual(SALE_READ_AT);
  });
});

describe("saleReserves", () => {
  /** An Asset Hub whose only view function is the one `saleReserves` asks for. */
  const apiReturning = (answer: unknown) => {
    const seen: unknown[][] = [];
    const api = {
      view: {
        AssetConversion: {
          get_reserves: (...args: unknown[]) => {
            seen.push(args);
            return Promise.resolve(answer);
          },
        },
      },
    };
    return { api: api as never, seen };
  };

  it("asks native-first and reads the pair back for the sale: CASH in, PAS out", async () => {
    // `get_reserves` answers in the order asked, so PAS is at [0]. Read straight through, the
    // pool would be priced upside down and nothing else would fail.
    const { api, seen } = apiReturning(["421298658123227", "103995356467"]);
    const r = await saleReserves(api);
    expect(r).toEqual({ in: 103_995_356_467n, out: 421_298_658_123_227n });

    const [first, second, options] = seen[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
      unknown,
    ];
    expect(first).toEqual({ parents: 1, interior: { type: "Here" } });
    expect(second.parents).toBe(0);
    // At best, like the quote and the dry run.
    expect(options).toEqual({ at: "best" });
  });

  it("calls get_reserves directly, since papi view functions have no .getValue()", async () => {
    // A wrong call falls back silently, so count the call instead of trusting the answer.
    const probe = apiReturning(["1", "2"]);
    await saleReserves(probe.api);
    expect(probe.seen).toHaveLength(1);
  });

  it("unwraps a runtime that answers with a wrapped value", async () => {
    const { api } = apiReturning({ value: [10n, 20n] });
    expect(await saleReserves(api)).toEqual({ in: 20n, out: 10n });
  });

  it("returns null rather than guessing, for every shape it cannot use", async () => {
    // On null the caller ships its ceiling, so none of these may throw or invent a pool.
    for (const answer of [undefined, null, [], ["1"], "not a pair", { value: null }]) {
      expect(await saleReserves(apiReturning(answer).api)).toBeNull();
    }
    const throwing = {
      view: {
        AssetConversion: {
          get_reserves: () => Promise.reject(new Error("no such view function")),
        },
      },
    };
    expect(await saleReserves(throwing as never)).toBeNull();
    expect(await saleReserves({} as never)).toBeNull();
  });
});
