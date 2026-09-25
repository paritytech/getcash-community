// Route selection over a scripted PSM: each of the four checks failing on its own, the margin at
// its boundary in both directions, and a resumed job's route coming from its record rather than
// the chain.

import { TOKENS } from "@getsome/core";
import { describe, expect, it } from "vitest";
import {
  ROUTE_MARGIN_FLOOR,
  chooseRoute,
  mintHeadroom,
  recordedRoute,
  withMargin,
  type ConversionRoute,
} from "./route";

const CASH = 1_000_000n; // one CASH, 6 decimals
const POOL: ConversionRoute = { tier: "pool" };
const PSM_AT_DEFAULT_FEE: ConversionRoute = { tier: "psm", external: "USDT", feeRate: 5_000 };

/** The PSM as it stands on Paseo Next today, scaled down: one external at 100%, no debt, the
 *  pallet's default fees. Weights and debts list every external of the instance; the first is
 *  USDT's, the rest belong to other externals. */
interface PsmWorld {
  instance: { max_debt: bigint; min_swap_amount: bigint; internal_decimals: number } | undefined;
  approval: { status: { type: string }; decimals: number } | undefined;
  weights: number[];
  debts: bigint[];
  mintingFee: number;
  redemptionFee: number;
}

const LIVE: PsmWorld = {
  instance: { max_debt: 100n * CASH, min_swap_amount: CASH, internal_decimals: 6 },
  approval: { status: { type: "AllEnabled" }, decimals: 6 },
  weights: [1_000_000],
  debts: [0n],
  mintingFee: 5_000,
  redemptionFee: 5_000,
};

function scriptedPsm(overrides: Partial<PsmWorld> = {}) {
  const world = { ...LIVE, ...overrides };
  const reads: unknown[][] = [];
  const entriesOf = <T>(values: T[]) => values.map((value) => ({ keyArgs: [], value }));
  const api = {
    query: {
      Psm: {
        Psm: {
          getValue: async (...keys: unknown[]) => {
            reads.push(["Psm", ...keys]);
            return world.instance;
          },
        },
        ExternalAssets: {
          getValue: async (...keys: unknown[]) => {
            reads.push(["ExternalAssets", ...keys]);
            return world.approval;
          },
        },
        AssetCeilingWeight: {
          getValue: async () => world.weights[0] ?? 0,
          getEntries: async () => entriesOf(world.weights),
        },
        PsmDebt: {
          getValue: async () => world.debts[0] ?? 0n,
          getEntries: async () => entriesOf(world.debts),
        },
        MintingFee: { getValue: async () => world.mintingFee },
        RedemptionFee: { getValue: async () => world.redemptionFee },
      },
    },
  } as never;
  return { api, reads };
}

const mint = (internalAmount: bigint) => ({ direction: "mint" as const, internalAmount });
const redeem = (internalAmount: bigint) => ({ direction: "redeem" as const, internalAmount });

describe("chooseRoute", () => {
  it("keys the PSM by the table's Locations and answers psm with the fee for the direction", async () => {
    const { api, reads } = scriptedPsm({ redemptionFee: 7_000 });
    expect(await chooseRoute(api, mint(50n * CASH))).toEqual(PSM_AT_DEFAULT_FEE);
    expect(reads).toEqual([
      ["Psm", TOKENS.CASH.location],
      ["ExternalAssets", TOKENS.CASH.location, TOKENS.USDT.location],
    ]);
    // Enough debt to redeem from; the redemption fee, not the minting one.
    const { api: withDebt } = scriptedPsm({ redemptionFee: 7_000, debts: [60n * CASH] });
    expect(await chooseRoute(withDebt, redeem(50n * CASH))).toEqual({
      tier: "psm",
      external: "USDT",
      feeRate: 7_000,
    });
  });

  it("check 1: no instance, or an external not approved on it, is the pool", async () => {
    expect(await chooseRoute(scriptedPsm({ instance: undefined }).api, mint(CASH))).toEqual(POOL);
    expect(await chooseRoute(scriptedPsm({ approval: undefined }).api, mint(CASH))).toEqual(POOL);
  });

  it("check 2: the circuit breaker stops minting first and redemption last", async () => {
    const debts = [60n * CASH];
    const halted = scriptedPsm({
      approval: { status: { type: "MintingDisabled" }, decimals: 6 },
      debts,
    }).api;
    expect(await chooseRoute(halted, mint(CASH))).toEqual(POOL);
    expect(await chooseRoute(halted, redeem(CASH))).toEqual(PSM_AT_DEFAULT_FEE);
    const stopped = scriptedPsm({
      approval: { status: { type: "AllDisabled" }, decimals: 6 },
      debts,
    }).api;
    expect(await chooseRoute(stopped, mint(CASH))).toEqual(POOL);
    expect(await chooseRoute(stopped, redeem(CASH))).toEqual(POOL);
  });

  it("check 3, mint: the external's own headroom must clear the amount plus the margin", async () => {
    // Ceiling 100 CASH at 100%; 50 CASH needs 55 of headroom.
    const clears = scriptedPsm({ debts: [45n * CASH] }).api;
    expect(await chooseRoute(clears, mint(50n * CASH))).toEqual(PSM_AT_DEFAULT_FEE);
    const oneShort = scriptedPsm({ debts: [45n * CASH + 1n] }).api;
    expect(await chooseRoute(oneShort, mint(50n * CASH))).toEqual(POOL);
  });

  it("check 3, mint: the ceiling is a normalised share, so a second external halves USDT's", async () => {
    // Two externals at equal weight: USDT's ceiling is 50 CASH, not 100.
    const shared = scriptedPsm({ weights: [1_000_000, 1_000_000], debts: [0n, 0n] }).api;
    expect(await chooseRoute(shared, mint(50n * CASH))).toEqual(POOL);
    expect(await chooseRoute(shared, mint(45n * CASH))).toEqual(PSM_AT_DEFAULT_FEE);
  });

  it("check 3, mint: another external's debt eats the aggregate headroom", async () => {
    // USDT's own ceiling is 50 CASH and untouched; the other external already owes 60 of the
    // instance's 100, leaving 40 in aggregate. 36 CASH needs 39.6; 37 needs 40.7.
    const crowded = scriptedPsm({ weights: [500_000, 500_000], debts: [0n, 60n * CASH] }).api;
    expect(await chooseRoute(crowded, mint(36n * CASH))).toEqual(PSM_AT_DEFAULT_FEE);
    expect(await chooseRoute(crowded, mint(37n * CASH))).toEqual(POOL);
  });

  it("check 3, mint: a zero weight, or a zero total, is a zero ceiling", async () => {
    expect(
      await chooseRoute(scriptedPsm({ weights: [0, 1_000_000], debts: [0n, 0n] }).api, mint(CASH)),
    ).toEqual(POOL);
    expect(await chooseRoute(scriptedPsm({ weights: [0] }).api, mint(CASH))).toEqual(POOL);
  });

  it("check 3, redeem: only debt minted through the pair can come back out", async () => {
    expect(await chooseRoute(scriptedPsm({ debts: [55n * CASH] }).api, redeem(50n * CASH))).toEqual(
      PSM_AT_DEFAULT_FEE,
    );
    expect(
      await chooseRoute(scriptedPsm({ debts: [55n * CASH - 1n] }).api, redeem(50n * CASH)),
    ).toEqual(POOL);
    // Today's chain: nothing minted yet, so nothing redeemable, however open the breaker.
    expect(await chooseRoute(scriptedPsm().api, redeem(CASH))).toEqual(POOL);
  });

  it("the margin has a floor: a small amount still needs a whole CASH of headroom", async () => {
    // 1 CASH with a 10% margin would need 1.1; the floor makes it 2.
    const twoLeft = scriptedPsm({ debts: [98n * CASH] }).api;
    expect(await chooseRoute(twoLeft, mint(CASH))).toEqual(PSM_AT_DEFAULT_FEE);
    const underTwo = scriptedPsm({ debts: [98n * CASH + 1n] }).api;
    expect(await chooseRoute(underTwo, mint(CASH))).toEqual(POOL);
    expect(await chooseRoute(scriptedPsm({ debts: [2n * CASH] }).api, redeem(CASH))).toEqual(
      PSM_AT_DEFAULT_FEE,
    );
    expect(await chooseRoute(scriptedPsm({ debts: [2n * CASH - 1n] }).api, redeem(CASH))).toEqual(
      POOL,
    );
  });

  it("check 4: below the instance's minimum swap is the pool, whatever the headroom", async () => {
    expect(await chooseRoute(scriptedPsm().api, mint(CASH - 1n))).toEqual(POOL);
    expect(await chooseRoute(scriptedPsm().api, mint(CASH))).toEqual(PSM_AT_DEFAULT_FEE);
    const redeemable = scriptedPsm({ debts: [10n * CASH] }).api;
    expect(await chooseRoute(redeemable, redeem(CASH - 1n))).toEqual(POOL);
    expect(await chooseRoute(redeemable, redeem(CASH))).toEqual(PSM_AT_DEFAULT_FEE);
  });
});

describe("withMargin and mintHeadroom", () => {
  it("adds ten percent, never less than the floor", () => {
    expect(withMargin(100n * CASH)).toBe(110n * CASH);
    expect(withMargin(10n * CASH)).toBe(10n * CASH + ROUTE_MARGIN_FLOOR); // exactly the floor
    expect(withMargin(CASH)).toBe(CASH + ROUTE_MARGIN_FLOOR);
    expect(withMargin(0n)).toBe(ROUTE_MARGIN_FLOOR);
  });

  it("takes the smaller of the aggregate and the normalised own headroom, floored at zero", () => {
    const base = { maxDebt: 100n, weight: 1n, totalWeight: 4n, debt: 0n, totalDebt: 0n };
    expect(mintHeadroom(base)).toBe(25n);
    expect(mintHeadroom({ ...base, totalDebt: 90n })).toBe(10n);
    expect(mintHeadroom({ ...base, debt: 30n, totalDebt: 30n })).toBe(0n);
    expect(mintHeadroom({ ...base, weight: 0n })).toBe(0n);
    expect(mintHeadroom({ ...base, totalWeight: 0n })).toBe(0n);
  });
});

describe("recordedRoute", () => {
  it("gives a resumed job the route its record carries, with no chain to consult", () => {
    // What the record says, not what the PSM would say now: a fee the chain has since changed
    // is still the one the buyer was quoted.
    expect(recordedRoute({ tier: "psm", external: "USDT", feeRate: 5_000 })).toEqual(
      PSM_AT_DEFAULT_FEE,
    );
    expect(recordedRoute({ tier: "pool" })).toEqual(POOL);
  });

  it("reads a record from before routes were recorded as the pool, which is what it was", () => {
    expect(recordedRoute({})).toEqual(POOL);
    expect(recordedRoute({ tier: undefined })).toEqual(POOL);
  });

  it("refuses a psm record it would have to guess about", () => {
    expect(() => recordedRoute({ tier: "psm", external: "USDT" })).toThrow(/fee rate/);
    expect(() => recordedRoute({ tier: "psm", external: "USDT", feeRate: 0.5 })).toThrow(
      /fee rate/,
    );
    expect(() => recordedRoute({ tier: "psm", external: "USDC", feeRate: 5_000 })).toThrow(
      /external/,
    );
    expect(() => recordedRoute({ tier: "fast", external: "USDT", feeRate: 5_000 })).toThrow(/tier/);
  });
});
