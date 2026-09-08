import { describe, expect, it } from "vitest";
import { createChainflipRail } from "./rail";
import type { GetQuoteV2Args, SwapSdkLike } from "./sdk";

/** Scripted SwapSdkLike: generous quotes, canned channel + status. */
function fakeSdk() {
  const quoteCalls: GetQuoteV2Args[] = [];
  const sdk: SwapSdkLike = {
    async getQuoteV2(args) {
      quoteCalls.push(args);
      return {
        quotes: [
          {
            type: "REGULAR",
            egressAmount: (BigInt(args.amount) * 10_000_000n).toString(),
            ingressAmount: args.amount,
            recommendedSlippageTolerancePercent: "2",
          },
        ],
      };
    },
    async requestDepositAddressV2() {
      return {
        depositAddress: "bc1qdeposit",
        depositChannelId: "1-Bitcoin-2",
        amount: "424242",
        estimatedDepositChannelExpiryTime: 123_456,
      };
    },
    async getStatusV2() {
      return { state: "SENT" };
    },
    async getSwapLimits() {
      return { minimumSwapAmounts: {} };
    },
  };
  return { sdk, quoteCalls };
}

describe("createChainflipRail", () => {
  it("sources() returns the full catalog by default and filters via opts.sources", () => {
    const { sdk } = fakeSdk();
    expect(createChainflipRail({ sdk }).sources()).toHaveLength(13);

    const filtered = createChainflipRail({ sdk, sources: ["btc", "eth"] }).sources();
    expect(filtered.map((s) => s.sourceId)).toEqual(["btc", "eth"]);
  });

  it("getQuote reverse-quotes through the injected sdk (target normalized to plancks)", async () => {
    const { sdk, quoteCalls } = fakeSdk();
    const rail = createChainflipRail({ sdk });
    const quote = await rail.getQuote({
      sourceId: "btc",
      target: { amount: 500_000_000_000n, decimals: 10 },
    });
    expect(quote.sourceId).toBe("btc");
    expect(quoteCalls[0]?.amount).toBe("250000"); // catalog reference amount
    expect(quote.source.amount > 0n).toBe(true);
  });

  it("usdt-tron quotes and opens a channel with the Tron/USDT identifiers", async () => {
    const { sdk, quoteCalls } = fakeSdk();
    const rail = createChainflipRail({ sdk });
    const quote = await rail.getQuote({
      sourceId: "usdt-tron",
      target: { amount: 500_000_000_000n, decimals: 10 },
    });
    // The catalog identifiers reach the SDK verbatim.
    expect(quoteCalls[0]?.srcChain).toBe("Tron");
    expect(quoteCalls[0]?.srcAsset).toBe("USDT");
    expect(quoteCalls[0]?.amount).toBe("250000000"); // 250 USDT reference, 6 decimals
    expect(quote.sourceId).toBe("usdt-tron");
    expect(quote.source.assetSymbol).toBe("USDT");

    const channel = await rail.requestDepositAddress({
      quote,
      destAddress: "12xEphemeralAddr",
      refundAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    });
    expect(channel.depositChannelId).toBeTruthy();
    expect(channel.deposit.assetSymbol).toBe("USDT");
  });

  it("non-DOT egress: destAsset, decimal conversion and zero default overhead (G4/D5)", async () => {
    const { sdk, quoteCalls } = fakeSdk();
    const rail = createChainflipRail({
      sdk,
      egress: { chain: "Assethub", asset: "USDT", decimals: 6 },
    });
    // 5000 whole units expressed at 10 decimals; must ceil-convert to 6-dec egress units.
    const quote = await rail.getQuote({
      sourceId: "usdt-tron",
      target: { amount: 5_000n * 10n ** 10n, decimals: 10 },
    });
    expect(quoteCalls.map((c) => c.destAsset)).toEqual(["USDT", "USDT"]);
    // 5e9 egress units needed; fake rate 1:1e7 -> 500 src, x1.05 buffer = 525, zero overhead.
    expect(quoteCalls[1]?.amount).toBe("525");
    expect(quote.sourceId).toBe("usdt-tron");
  });

  it("rejects a quote for a source excluded by opts.sources", async () => {
    const { sdk } = fakeSdk();
    const rail = createChainflipRail({ sdk, sources: ["eth"] });
    await expect(
      rail.getQuote({ sourceId: "btc", target: { amount: 1n, decimals: 10 } }),
    ).rejects.toThrow(/Unknown or disabled/);
  });

  it("requestDepositAddress + getStatus round-trip through the sdk with mapping applied", async () => {
    const { sdk } = fakeSdk();
    const rail = createChainflipRail({ sdk });
    const quote = await rail.getQuote({
      sourceId: "btc",
      target: { amount: 500_000_000_000n, decimals: 10 },
    });
    const channel = await rail.requestDepositAddress({
      quote,
      destAddress: "5Ephemeral",
      refundAddress: "bc1qrefundaddressxxxxxxxxxxxxxx",
    });
    expect(channel.depositChannelId).toBe("1-Bitcoin-2");
    expect(channel.deposit.amount).toBe(424_242n);
    expect(channel.deposit.expiresAt).toBe(123_456);

    const status = await rail.getStatus(channel.depositChannelId);
    expect(status.status).toBe("sending"); // SENT normalized
  });

  it("probeLiquidity gates per rail instance", async () => {
    const { sdk, quoteCalls } = fakeSdk();
    const rail = createChainflipRail({ sdk });
    const [a, b] = await Promise.all([rail.probeLiquidity("btc"), rail.probeLiquidity("btc")]);
    expect(a).toEqual({ status: "available" });
    expect(b).toEqual({ status: "available" });
    expect(quoteCalls).toHaveLength(2); // deduped: one ref + one precise
  });
});
