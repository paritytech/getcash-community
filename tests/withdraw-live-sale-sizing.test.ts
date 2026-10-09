// Sizing a fiat sale's figure over a scripted pool: what the sale lands less the program's floor,
// the margin the check before the purse keeps and a point for KYC, less what the payment costs,
// cut to the sale's decimals, and what comes back of the rest; and the check before the purse,
// which keeps its margin under the worker's floor. On the PSM tier the figure is exact: what the
// redeem lands in USDT less the payment's cost, and the check holds the figure to that alone.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@novasamatech/host-api", () => ({
  PaymentRequestErr: class PaymentRequestErr extends Error {},
  PaymentStatusErr: class PaymentStatusErr extends Error {},
}));
vi.mock("../lib/host-payments", () => ({
  requestPayment: vi.fn(),
  subscribePaymentStatus: vi.fn(),
}));
vi.mock("../lib/chainflip-backend", () => ({ NETWORK: "testnet", mainnetSdk: vi.fn() }));

/** A pool that sells one CASH unit for `price` planck and prices the native at a thousandth in
 *  USDT, the payment's fee, the key's existential deposit and USDT's min_balance as Asset Hub
 *  states them. Keeps who each fee estimate paid. */
const pool = vi.hoisted(() => ({ price: 4_000n, payees: [] as string[] }));
vi.mock("../lib/host-chain", () => ({
  ASSET_HUB: "asset-hub",
  PEOPLE: "people",
  ASSET_HUB_GENESIS: "0xah",
  PEOPLE_GENESIS: "0xpe",
  connectChain: async () => ({
    getTypedApi: () => ({
      apis: {
        AssetConversionApi: {
          quote_price_exact_tokens_for_tokens: async (_a: unknown, _b: unknown, sold: bigint) =>
            sold * pool.price,
          quote_price_tokens_for_exact_tokens: async (_a: unknown, _b: unknown, fee: bigint) =>
            fee / 1_000n,
        },
      },
      tx: {
        Balances: {
          transfer_keep_alive: (args: { dest: { value: string } }) => {
            pool.payees.push(args.dest.value);
            return { getEstimatedFees: async () => 160_000_000n };
          },
        },
        Assets: {
          transfer_keep_alive: (args: { target: { value: string } }) => {
            pool.payees.push(args.target.value);
            return { getEstimatedFees: async () => 160_000_000n };
          },
        },
      },
      query: { Assets: { Asset: { getValue: async () => ({ min_balance: 70_000n }) } } },
      constants: { Balances: { ExistentialDeposit: async () => 100_123_456n } },
    }),
  }),
}));

// The fee estimate asks the chains how CASH moves and reads People's pool; here the move is a
// teleport and the fees are the 0.45 CASH the figures below assume.
vi.mock("@getsome/funding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@getsome/funding")>()),
  chooseCashTransfer: async () => "teleport",
}));
vi.mock("@getsome/withdraw", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@getsome/withdraw")>()),
  estimateDirectFeesCash: async () => 450_000n,
}));

import type { ConversionRoute } from "@getsome/funding";
import { meldCommitmentFundable, sizeMeldCommitment } from "../lib/withdraw-live";

const DEPOSIT = "14Kt4HmnCzMqUKvWcGZdLaWkLNcL4TcUSXYvKyKdbMhsvRxM";
const POOL: ConversionRoute = { tier: "pool" };
const PSM: ConversionRoute = { tier: "psm", external: "USDT", feeRate: 5_000 };
/** 100 CASH less the 0.45 CASH of fees, sold at 4000 planck a unit. */
const AMOUNT = 100_000_000n;
const LANDS = 99_550_000n * 4_000n;
/** The fee with its quarter of headroom, and the existential deposit. */
const COST = 200_000_000n + 100_123_456n;

describe("a fiat sale's figure", () => {
  beforeEach(() => {
    pool.price = 4_000n;
    pool.payees.length = 0;
  });

  it("is what the sale lands less 6.5% and the payment's cost, cut to four decimals", async () => {
    const { planck } = await sizeMeldCommitment(AMOUNT, POOL);
    // 398.2 PAS less 6.5% is 372.317; less the cost is 372.016876544, cut to 372.0160.
    expect((LANDS * 9_350n) / 10_000n - COST).toBe(372_016_876_544n);
    expect(planck).toBe(372_016_000_000n);
  });

  it("names the CASH the rest should bring back, at today's price", async () => {
    const { planck, backCash } = await sizeMeldCommitment(AMOUNT, POOL);
    // 2.588 PAS left once the provider and the payment are paid, of the 398.2 the 99.55 CASH sold
    // for: about 6.47 CASH.
    expect(LANDS - planck - COST).toBe(25_883_876_544n);
    expect(backCash).toBe(6_470_969n);
  });

  it("brings nothing back from a rest too small to send home", async () => {
    // 2 CASH sells for 0.62 PAS; 0.04 PAS is left, under the 0.1 PAS worth the way back.
    const { planck, backCash } = await sizeMeldCommitment(2_000_000n, POOL);
    expect(planck).toBe(5_496_000_000n);
    expect(backCash).toBe(0n);
  });

  it("is refused when the fees take what the sale would land", async () => {
    await expect(sizeMeldCommitment(450_000n, POOL)).rejects.toThrow(/does not cover the network/);
    await expect(sizeMeldCommitment(450_100n, POOL)).rejects.toThrow(/does not cover the network/);
  });

  it("is exactly what the PSM redeem lands in USDT less the payment's cost, with no floor under it", async () => {
    const { planck, backCash } = await sizeMeldCommitment(AMOUNT, PSM);
    // 99.55 CASH less the 1% earmark redeems 98.5545 CASH at a 0.5% fee: 98.061727 USDT. The
    // payment costs 0.16 USDT with its headroom plus the 0.07 min_balance, and the figure is
    // cut to four decimals; the 27 units left are not worth sending home.
    expect(planck).toBe(97_791_700n);
    expect(backCash).toBe(0n);
  });
});

describe("the check before the purse", () => {
  beforeEach(() => {
    pool.price = 4_000n;
    pool.payees.length = 0;
  });

  it("passes at the price it was sized at, pricing the payment to the provider's address", async () => {
    const { planck: figure } = await sizeMeldCommitment(AMOUNT, POOL);
    expect(await meldCommitmentFundable(AMOUNT, figure, DEPOSIT, POOL)).toBe(true);
    expect(pool.payees.at(-1)).toBe(DEPOSIT);
  });

  it("passes a price that moved by a point during KYC", async () => {
    const { planck: figure } = await sizeMeldCommitment(AMOUNT, POOL);
    pool.price = 3_960n;
    expect(await meldCommitmentFundable(AMOUNT, figure, DEPOSIT, POOL)).toBe(true);
  });

  it("keeps half a point under the worker's floor, for the minutes until the worker sizes the sale", async () => {
    const { planck: figure } = await sizeMeldCommitment(AMOUNT, POOL);
    pool.price = 3_950n;
    const lands = 99_550_000n * 3_950n;
    // The worker's floor alone would still cover the payment; the check keeps its margin.
    expect((lands * 9_500n) / 10_000n).toBeGreaterThan(figure + COST);
    expect(await meldCommitmentFundable(AMOUNT, figure, DEPOSIT, POOL)).toBe(false);
  });

  it("refuses an amount the fees take whole", async () => {
    expect(await meldCommitmentFundable(450_000n, 1_000_000n, DEPOSIT, POOL)).toBe(false);
  });

  it("holds a PSM figure to the exact redeem, with no margin either way", async () => {
    // The figure that leaves exactly the payment's cost of the 98.061727 USDT redeemed, and one
    // unit more.
    expect(await meldCommitmentFundable(AMOUNT, 97_791_727n, DEPOSIT, PSM)).toBe(true);
    expect(await meldCommitmentFundable(AMOUNT, 97_791_728n, DEPOSIT, PSM)).toBe(false);
    expect(pool.payees.at(-1)).toBe(DEPOSIT);
  });
});
