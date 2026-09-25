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

import { quoteWithdrawOffers } from "../lib/withdraw-live";

const PROVIDERS = WITHDRAW_NETWORKS.flatMap((n) => n.destinations).filter(
  (d) => d.rail !== "direct",
);
const CASH = 50_000_000n; // 50 CASH
/** 50 CASH less the 0.45 CASH of fees sells for twice as many planck, less 6% headroom. */
const SELLABLE = (49_550_000n * 2n * 94n) / 100n;

function reset() {
  asked.length = 0;
  poolReverseQuotes.count = 0;
}

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

  it("prices the quote's fee split into the destination asset with the quote's own numbers", async () => {
    reset();
    script.quote = (asset, amount) =>
      asset === "USDC"
        ? {
            type: "REGULAR",
            egressAmount: "24190000",
            estimatedDurationSeconds: 600,
            depositAmount: amount,
            includedFees: [
              // A tenth of the deposit, so it prices to a tenth of the egress: 2.419 USDC.
              { chain: "Assethub", asset: "DOT", amount: "9315400", type: "INGRESS" },
              { chain: "Ethereum", asset: "USDC", amount: "210000", type: "NETWORK" },
              { chain: "Ethereum", asset: "USDC", amount: "260000", type: "EGRESS" },
            ],
          }
        : { type: "REGULAR", egressAmount: "123456", estimatedDurationSeconds: null };
    const { offers } = await quoteWithdrawOffers(CASH, PROVIDERS);
    expect(offers.get("usdc-eth")).toMatchObject({
      state: "available",
      fees: {
        rows: [
          // Ingress and egress under one name, each figure rounded up so a fee is never understated.
          { label: "Network fee", value: "2.68 USDC" },
          { label: "Swap fee", value: "0.21 USDC" },
        ],
        total: "2.89 USDC",
        equivalent: "≈ 27.08 USDC",
        receive: "24.19 USDC",
        rate: "$1 CASH ≈ 0.54 USDC",
      },
    });
    // A quote naming no fees offers no split; the summary keeps its plain caption.
    expect(offers.get("btc")).not.toHaveProperty("fees");
  });

  it("drops the split whole when a fee cannot be priced into the destination asset", async () => {
    reset();
    script.quote = (asset, amount) => ({
      type: "REGULAR",
      egressAmount: "100000000",
      estimatedDurationSeconds: null,
      depositAmount: amount,
      includedFees:
        asset === "BTC"
          ? // A USDC fee with no intermediate leg to price it through.
            [{ chain: "Ethereum", asset: "USDC", amount: "210000", type: "NETWORK" }]
          : // A fee kind the rows don't name.
            [{ chain: "Ethereum", asset, amount: "1", type: "MYSTERY" }],
    });
    const { offers } = await quoteWithdrawOffers(CASH, PROVIDERS);
    expect(offers.get("btc")?.state).toBe("available");
    expect(offers.get("btc")).not.toHaveProperty("fees");
    expect(offers.get("usdc-eth")).not.toHaveProperty("fees");
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
