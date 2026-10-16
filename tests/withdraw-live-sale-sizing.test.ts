// Sizing a fiat sale's figure over a scripted pool: what the sale lands less the program's floor,
// the margin the check before the purse keeps and a point for KYC, less what the payment costs,
// cut to the sale's decimals, and what comes back of the rest; and the check before the purse,
// which keeps its margin under the worker's floor.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@novasamatech/host-api", () => ({
  PaymentRequestErr: class PaymentRequestErr extends Error {},
  PaymentStatusErr: class PaymentStatusErr extends Error {},
}));
vi.mock("../lib/host-payments", () => ({
  requestPayment: vi.fn(),
  subscribePaymentStatus: vi.fn(),
}));
vi.mock("../lib/chainflip-backend", () => ({
  NETWORK: "testnet",
  mainnetSdk: vi.fn(),
  saleChannelsOpen: () => true,
}));

/** A pool that sells one CASH unit for `price` planck, and the payment's fee and the key's
 *  existential deposit as Asset Hub states them. Keeps who each fee estimate paid. */
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
        },
      },
      tx: {
        Balances: {
          transfer_keep_alive: (args: { dest: { value: string } }) => {
            pool.payees.push(args.dest.value);
            return { getEstimatedFees: async () => 160_000_000n };
          },
        },
      },
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

import { meldCommitmentFundable, sizeMeldCommitment } from "../lib/withdraw-live";

const DEPOSIT = "14Kt4HmnCzMqUKvWcGZdLaWkLNcL4TcUSXYvKyKdbMhsvRxM";
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

  it("is what the sale lands less 2.5% and the payment's cost, cut to four decimals", async () => {
    const { planck } = await sizeMeldCommitment(AMOUNT);
    // The worker's 1% floor, the half point the check before the purse keeps and the point for
    // KYC: 398.2 PAS less 2.5% is 388.245; less the cost is 387.944876544, cut to 387.9440.
    expect((LANDS * 9_750n) / 10_000n - COST).toBe(387_944_876_544n);
    expect(planck).toBe(387_944_000_000n);
  });

  it("names the CASH the rest should bring back, at today's price", async () => {
    const { planck, backCash } = await sizeMeldCommitment(AMOUNT);
    // 0.9956 PAS left once the provider and the payment are paid, of the 398.2 the 99.55 CASH
    // sold for: about 2.49 CASH.
    expect(LANDS - planck - COST).toBe(9_955_876_544n);
    expect(backCash).toBe(2_488_969n);
  });

  it("brings nothing back from a rest too small to send home", async () => {
    // 2 CASH sells for 0.62 PAS; 0.0156 PAS is left, under the 0.1 PAS worth the way back.
    const { planck, backCash } = await sizeMeldCommitment(2_000_000n);
    expect(planck).toBe(5_744_000_000n);
    expect(backCash).toBe(0n);
  });

  it("is refused when the fees take what the sale would land", async () => {
    await expect(sizeMeldCommitment(450_000n)).rejects.toThrow(/does not cover the network fees/);
    await expect(sizeMeldCommitment(450_100n)).rejects.toThrow(/does not cover the network fees/);
  });
});

describe("the check before the purse", () => {
  beforeEach(() => {
    pool.price = 4_000n;
    pool.payees.length = 0;
  });

  it("passes at the price it was sized at, pricing the payment to the provider's address", async () => {
    const { planck: figure } = await sizeMeldCommitment(AMOUNT);
    expect(await meldCommitmentFundable(AMOUNT, figure, DEPOSIT)).toBe(true);
    expect(pool.payees.at(-1)).toBe(DEPOSIT);
  });

  it("passes a price that moved by a point during KYC", async () => {
    const { planck: figure } = await sizeMeldCommitment(AMOUNT);
    pool.price = 3_960n;
    expect(await meldCommitmentFundable(AMOUNT, figure, DEPOSIT)).toBe(true);
  });

  it("keeps half a point under the worker's floor, for the minutes until the worker sizes the sale", async () => {
    const { planck: figure } = await sizeMeldCommitment(AMOUNT);
    pool.price = 3_950n;
    const lands = 99_550_000n * 3_950n;
    // The worker's floor alone would still cover the payment; the check keeps its margin.
    expect((lands * 9_900n) / 10_000n).toBeGreaterThan(figure + COST);
    expect(await meldCommitmentFundable(AMOUNT, figure, DEPOSIT)).toBe(false);
  });

  it("refuses an amount the fees take whole", async () => {
    expect(await meldCommitmentFundable(450_000n, 1_000_000n, DEPOSIT)).toBe(false);
  });

  it("holds a sale handed off at an older slippage to the floor the worker will ship it at", async () => {
    // Sized at 5%: 398.2 PAS less 6.5% is 372.317; less the cost, cut to four decimals, 372.0160.
    const figure = 372_016_000_000n;
    pool.price = 3_920n;
    // 2% lower, the worker's 5% floor no longer covers the payment and its cost...
    expect((99_550_000n * 3_920n * 9_500n) / 10_000n).toBeLessThan(figure + COST);
    expect(await meldCommitmentFundable(AMOUNT, figure, DEPOSIT, 5)).toBe(false);
    // ...while today's 1% would wave the purse through.
    expect(await meldCommitmentFundable(AMOUNT, figure, DEPOSIT)).toBe(true);
  });
});
