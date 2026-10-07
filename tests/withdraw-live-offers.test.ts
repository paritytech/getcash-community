// Quoting the provider destinations for an amount, over a scripted pool and a scripted Chainflip:
// what lands, the minimum priced back into CASH once, a provider that is not answering caught on
// the first destination, and a single refused pair marked alone.

import { describe, expect, it, vi } from "vitest";
import {
  BelowMinimumSwapAmountError,
  ChainflipRequestError,
  type SwapSdkLike,
} from "@getsome/chainflip";
import { WITHDRAW_NETWORKS } from "../app/withdraw/destinations";

vi.mock("@novasamatech/host-api", () => ({
  PaymentRequestErr: class PaymentRequestErr extends Error {},
  PaymentStatusErr: class PaymentStatusErr extends Error {},
}));
vi.mock("../lib/host-payments", () => ({
  requestPayment: vi.fn(),
  subscribePaymentStatus: vi.fn(),
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

/** A pool where one CASH unit sells for two planck, and the reverse. Counts its reverse quotes. */
const poolReverseQuotes = { count: 0 };
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
          quote_price_tokens_for_exact_tokens: async (_a: unknown, _b: unknown, native: bigint) => {
            poolReverseQuotes.count += 1;
            return native / 2n;
          },
        },
      },
    }),
  }),
}));

/** Chainflip, answering per destination asset from a script. */
const script: { quote: (asset: string, amount: string) => unknown } = { quote: () => ({}) };
const asked: string[] = [];
vi.mock("../lib/chainflip-backend", () => ({
  NETWORK: "mainnet",
  mainnetSdk: async (): Promise<SwapSdkLike> => ({
    getQuoteV2: async (args) => {
      asked.push(args.destAsset);
      const quote = script.quote(args.destAsset, args.amount);
      if (quote instanceof Error) throw quote;
      return { quotes: [quote] };
    },
    requestDepositAddressV2: async () => ({}),
    getStatusV2: async () => ({}),
    getSwapLimits: async () => ({ minimumSwapAmounts: {} }),
  }),
}));

import { chooseWithdrawRoute, quoteDirectReceive, quoteWithdrawOffers } from "../lib/withdraw-live";

const PROVIDERS = WITHDRAW_NETWORKS.flatMap((n) => n.destinations).filter(
  (d) => d.rail !== "direct",
);
const CASH = 50_000_000n; // 50 CASH
/** 50 CASH less the scripted 0.45 CASH of fees sells for twice as many planck, less 6% headroom. */
const SELLABLE = (49_550_000n * 2n * 94n) / 100n;

function reset() {
  asked.length = 0;
  poolReverseQuotes.count = 0;
}

describe("what a direct withdrawal lands per token", () => {
  it("sells once for the native, twice for a stable, redeems at the PSM's rate, and lands dotUSD as it is", async () => {
    const amount = 21_000_000n;
    const sold = amount - 450_000n;
    expect(await quoteDirectReceive(amount, { tier: "pool" })).toBe(sold * 2n);
    expect(await quoteDirectReceive(amount, { tier: "pool", external: "USDC" })).toBe(sold * 4n);
    expect(
      await quoteDirectReceive(amount, { tier: "psm", external: "USDT", feeRate: 5_000 }),
    ).toBe(sold - (sold * 5_000n + 999_999n) / 1_000_000n);
    expect(await quoteDirectReceive(amount, { tier: "dotusd" })).toBe(sold);
    // An amount the fees eat whole lands nothing on any tier.
    expect(await quoteDirectReceive(400_000n, { tier: "dotusd" })).toBe(0n);
  });

  it("decides the native and dotUSD without a chain read", async () => {
    expect(await chooseWithdrawRoute(21_000_000n, "native")).toEqual({ tier: "pool" });
    expect(await chooseWithdrawRoute(21_000_000n, "dotUSD")).toEqual({ tier: "dotusd" });
  });
});

describe("quoting the provider destinations for an amount", () => {
  it("asks every destination for the sellable native and formats what lands", async () => {
    reset();
    script.quote = (asset, amount) => ({
      type: "REGULAR",
      egressAmount: asset === "BTC" ? "123456" : "5000000",
      estimatedDurationSeconds: 600,
      amountAsked: amount,
    });
    const { sellable, offers } = await quoteWithdrawOffers(CASH, PROVIDERS);
    expect(sellable).toBe(SELLABLE);
    expect(asked).toHaveLength(PROVIDERS.length);
    // Six decimals at most, rounded up, so a payout is never overstated.
    expect(offers.get("btc")).toEqual({
      state: "available",
      egress: 123_456n,
      formatted: "0.001235 BTC",
      etaSeconds: 600,
    });
    expect(offers.get("usdc-eth")).toMatchObject({ state: "available", formatted: "5 USDC" });
  });

  it("prices the provider's minimum back into CASH once, headroom included", async () => {
    reset();
    const minimum = 40_000_000_000n; // 4 DOT
    script.quote = () => new BelowMinimumSwapAmountError(minimum);
    const { offers } = await quoteWithdrawOffers(CASH, PROVIDERS);
    // 4.24 DOT at two planck per CASH unit, plus the 0.45 CASH of fees.
    const expected = (minimum + (minimum * 6n) / 100n) / 2n + 450_000n;
    for (const destination of PROVIDERS) {
      expect(offers.get(destination.id)).toEqual({ state: "too-small", minimumCash: expected });
    }
    expect(poolReverseQuotes.count).toBe(1);
  });

  it("marks every destination off the first when Chainflip is not answering, asking nobody else", async () => {
    reset();
    script.quote = () => new ChainflipRequestError("Asset HubDot is disabled", 503);
    const { offers } = await quoteWithdrawOffers(CASH, PROVIDERS);
    expect(asked).toHaveLength(1);
    for (const destination of PROVIDERS) {
      expect(offers.get(destination.id)).toEqual({
        state: "unavailable",
        reason: "Asset HubDot is disabled",
      });
    }
  });

  it("marks a single refused pair alone and keeps asking the rest", async () => {
    reset();
    script.quote = (asset) =>
      asset === "TRX"
        ? new ChainflipRequestError("insufficient liquidity", 400)
        : { type: "REGULAR", egressAmount: "1", estimatedDurationSeconds: null };
    const { offers } = await quoteWithdrawOffers(CASH, PROVIDERS);
    expect(asked).toHaveLength(PROVIDERS.length);
    expect(offers.get("trx-tron")?.state).toBe("unavailable");
    expect(offers.get("btc")?.state).toBe("available");
  });

  it("probes with one planck when the fees eat the amount, so the minimum still comes back", async () => {
    reset();
    script.quote = (_asset, amount) =>
      amount === "1"
        ? new BelowMinimumSwapAmountError(40_000_000_000n)
        : new Error(`unexpected probe of ${amount}`);
    const { sellable, offers } = await quoteWithdrawOffers(100_000n, PROVIDERS);
    expect(sellable).toBe(0n);
    expect(offers.get("btc")?.state).toBe("too-small");
  });
});
