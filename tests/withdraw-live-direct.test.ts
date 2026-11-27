// What a direct withdrawal lands per token and the sale it takes, over a scripted pool and a
// scripted choice of the sale.

import { describe, expect, it, vi } from "vitest";
import type { ConversionRoute } from "@getsome/funding";

vi.mock("@novasamatech/host-api", () => ({
  PaymentRequestErr: class PaymentRequestErr extends Error {},
  PaymentStatusErr: class PaymentStatusErr extends Error {},
}));
vi.mock("../lib/host-payments", () => ({
  requestPayment: vi.fn(),
  subscribePaymentStatus: vi.fn(),
}));

// The fee estimate asks the chains how CASH moves and reads People's pool; here the move is a
// teleport and the fees are the 0.45 CASH the figures below assume. The sale the chain picks for
// a stable is the one each test sets.
const chain: { route: ConversionRoute } = { route: { tier: "pool" } };
vi.mock("@getsome/funding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@getsome/funding")>()),
  chooseCashTransfer: async () => "teleport",
  chooseRoute: async () => chain.route,
}));
vi.mock("@getsome/withdraw", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@getsome/withdraw")>()),
  estimateDirectFeesCash: async () => 450_000n,
}));

/** A pool where one CASH unit sells for two planck, and the reverse; the redeem's dispatch fee
 *  and the floors a redeem is held to as Asset Hub states them. */
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
            sold * 2n,
          quote_price_tokens_for_exact_tokens: async (_a: unknown, _b: unknown, native: bigint) =>
            native / 2n,
        },
      },
      tx: { Psm: { redeem: () => ({ getEstimatedFees: async () => 100_000n }) } },
      query: {
        Assets: { Asset: { getValue: async () => ({ min_balance: 70_000n }) } },
        Psm: { Psm: { getValue: async () => ({ min_swap_amount: 1_000_000n }) } },
      },
    }),
  }),
}));

import { chooseWithdrawRoute, quoteDirectReceive } from "../lib/withdraw-live";

const PSM = { tier: "psm", external: "USDT", feeRate: 5_000 } as const;
/** What the redeem leaves on the key of the CASH that reaches it: its fee, 0.05 CASH at the
 *  pool's price with its tenth of margin, and the CASH account's min_balance. */
const KEPT_ON_KEY = 55_000n + 70_000n;

describe("what a direct withdrawal lands per token", () => {
  it("sells once for the native, twice for a stable, redeems what the key keeps nothing of at the PSM's rate, and lands dotUSD as it is", async () => {
    const amount = 21_000_000n;
    const sold = amount - 450_000n;
    expect(await quoteDirectReceive(amount, { tier: "pool" })).toBe(sold * 2n);
    expect(await quoteDirectReceive(amount, { tier: "pool", external: "USDC" })).toBe(sold * 4n);
    const exit = sold - KEPT_ON_KEY;
    expect(await quoteDirectReceive(amount, PSM)).toBe(
      exit - (exit * 5_000n + 999_999n) / 1_000_000n,
    );
    expect(await quoteDirectReceive(amount, { tier: "dotusd" })).toBe(sold);
    // An amount the fees eat whole lands nothing on any tier, nor one the redeem's fee and the
    // account's minimum take.
    expect(await quoteDirectReceive(400_000n, { tier: "dotusd" })).toBe(0n);
    expect(await quoteDirectReceive(450_000n + KEPT_ON_KEY, PSM)).toBe(0n);
  });

  it("decides the native and dotUSD without a chain read", async () => {
    expect(await chooseWithdrawRoute(21_000_000n, "native", 0n)).toEqual({ tier: "pool" });
    expect(await chooseWithdrawRoute(21_000_000n, "dotUSD", 0n)).toEqual({ tier: "dotusd" });
  });
});

describe("taking the PSM only when the redeem clears its floors with the fees doubled", () => {
  /** The scripted fees doubled: 0.9 CASH before the redeem, its own 0.1 with a tenth of margin,
   *  and 0.07 left on the key. The PSM redeems 1 CASH at least, so the redeem clears it from 2.08
   *  CASH, where today's fees would clear it from 1.575. */
  const CLEARS = 2_080_000n;

  it("keeps the PSM for a direct withdrawal from there, and feeds the pool through the native under it", async () => {
    chain.route = PSM;
    expect(await chooseWithdrawRoute(CLEARS, "USDT", 0n)).toEqual(PSM);
    expect(await chooseWithdrawRoute(CLEARS - 1n, "USDT", 0n)).toEqual({
      tier: "pool",
      external: "USDT",
    });
  });
});
