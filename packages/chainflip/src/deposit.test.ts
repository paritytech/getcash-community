import { describe, expect, it } from "vitest";
import type { OpenChannelArgs, Quote } from "@getsome/core";
import { requestDepositAddress, type DepositBackend } from "./deposit";
import type { RequestDepositAddressV2Args } from "./sdk";
import { SOURCE_CONFIG_BY_ID } from "./sources";

const btc = SOURCE_CONFIG_BY_ID.get("btc")!;

function makeQuote(raw: unknown): Quote {
  return {
    sourceId: "btc",
    source: { amount: 132_562n, formatted: "0.00132562", assetSymbol: "BTC", decimals: 8 },
    raw,
  };
}

function capturingBackend(result: unknown) {
  let captured: RequestDepositAddressV2Args | undefined;
  const backend: DepositBackend = {
    requestDepositAddressV2: async (args) => {
      captured = args;
      return result;
    },
  };
  return { backend, captured: () => captured };
}

const CHANNEL_RESULT = {
  depositAddress: "bc1qdeposit",
  depositChannelId: "123-Bitcoin-45",
  amount: "132562",
  estimatedDepositChannelExpiryTime: 1_780_000_000_000,
};

function args(quote: Quote, refundAddress = "bc1qrefundaddressxxxxxxxxxxxxxx"): OpenChannelArgs {
  return { quote, destAddress: "5EphemeralPrefix0Address", refundAddress };
}

describe("requestDepositAddress", () => {
  it("passes fillOrKillParams with Chainflip field names verbatim", async () => {
    const raw = { recommendedSlippageTolerancePercent: "1.5", other: "kept" };
    const { backend, captured } = capturingBackend(CHANNEL_RESULT);

    await requestDepositAddress(backend, btc, args(makeQuote(raw)));

    const sent = captured()!;
    expect(sent.quote).toBe(raw); // the raw quote object, untouched
    expect(sent.destAddress).toBe("5EphemeralPrefix0Address");
    expect(sent.fillOrKillParams).toEqual({
      refundAddress: "bc1qrefundaddressxxxxxxxxxxxxxx",
      slippageTolerancePercent: "1.5",
      retryDurationMinutes: 10,
    });
  });

  it("defaults slippageTolerancePercent to '3' when the quote has no recommendation", async () => {
    const { backend, captured } = capturingBackend(CHANNEL_RESULT);
    await requestDepositAddress(backend, btc, args(makeQuote({})));
    expect(captured()!.fillOrKillParams.slippageTolerancePercent).toBe("3");
  });

  it("maps the SDK result to a core DepositChannel (expiry in ms, ceil formatting)", async () => {
    const { backend } = capturingBackend(CHANNEL_RESULT);
    const channel = await requestDepositAddress(backend, btc, args(makeQuote({})));

    expect(channel.depositChannelId).toBe("123-Bitcoin-45");
    expect(channel.deposit).toEqual({
      address: "bc1qdeposit",
      amount: 132_562n,
      formatted: "0.00132562",
      assetSymbol: "BTC",
      expiresAt: 1_780_000_000_000,
    });
  });

  it("falls back to the quote amount when the SDK omits amount; missing expiry maps to 0", async () => {
    const { backend } = capturingBackend({
      depositAddress: "bc1qdeposit",
      depositChannelId: "9-Bitcoin-1",
    });
    const channel = await requestDepositAddress(backend, btc, args(makeQuote({})));
    expect(channel.deposit.amount).toBe(132_562n);
    expect(channel.deposit.expiresAt).toBe(0);
  });

  it("requires a refund address", async () => {
    const { backend } = capturingBackend(CHANNEL_RESULT);
    await expect(requestDepositAddress(backend, btc, args(makeQuote({}), ""))).rejects.toThrow(
      /BTC refund address is required/,
    );
  });

  it("wraps backend failures in a stable message", async () => {
    const backend: DepositBackend = {
      requestDepositAddressV2: async () => {
        throw new Error("boom");
      },
    };
    await expect(requestDepositAddress(backend, btc, args(makeQuote({})))).rejects.toThrow(
      /Failed to open swap deposit channel/,
    );
  });
});
