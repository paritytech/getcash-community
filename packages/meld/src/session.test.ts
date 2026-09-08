import { describe, expect, it } from "vitest";
import type { OpenChannelArgs, Quote } from "@getsome/core";
import type { MeldClientLike, MeldSessionRequest } from "./client";
import type { MeldQuoteRaw } from "./quote";
import { requestMeldDeposit } from "./session";

const BURNER = "5EphemeralBurnerAddressxxxxxxxxxxxxxxxxxxxxxxxxxxx";

function meldQuote(): Quote {
  const raw: MeldQuoteRaw = {
    provider: { serviceProvider: "TRANSAK", sourceAmount: "141.89", destinationAmount: "20.63" },
    context: { country: "US", fiat: "USD", token: "DOT_ASSETHUB", method: "CARD" },
    destinationAmount: "20",
  };
  return {
    sourceId: "dot-assethub",
    source: { amount: 200_000_000_000n, formatted: "20", assetSymbol: "DOT", decimals: 10 },
    raw,
  };
}

function capturingClient(
  sessionId = "meld-sess-1",
  widgetUrl = "https://pay.meld/x",
  fundingRequestId = "funding-1",
) {
  let captured: MeldSessionRequest | undefined;
  const client: MeldClientLike = {
    getQuote: async () => ({ quotes: [] }),
    createSession: async (req) => {
      captured = req;
      return { fundingRequestId, sessionId, externalSessionId: "ext", widgetUrl };
    },
    // The adapter's vocabulary, not Meld's.
    getStatus: async () => ({ status: "session_opened" }),
  };
  return { client, captured: () => captured };
}

function args(quote: Quote): OpenChannelArgs {
  return { quote, destAddress: BURNER, refundAddress: "" };
}

describe("requestMeldDeposit", () => {
  it("creates a Meld session for the quoted provider, locked to the burner", async () => {
    const { client, captured } = capturingClient();
    await requestMeldDeposit(client, args(meldQuote()));

    expect(captured()).toEqual({
      serviceProvider: "TRANSAK",
      country: "US",
      sourceCurrencyCode: "USD",
      sourceAmount: "141.89",
      destinationCurrencyCode: "DOT_ASSETHUB",
      destinationAmount: "20.63",
      walletAddress: BURNER,
      paymentMethodType: "CARD",
    });
  });

  it("maps the session to a DepositChannel (burner is the delivery address) plus the pay URL", async () => {
    const { client } = capturingClient("meld-sess-1", "https://pay.meld/x");
    const { channel, widgetUrl } = await requestMeldDeposit(client, args(meldQuote()));

    // The adapter's funding-request id, which core persists and polls by.
    expect(channel.depositChannelId).toBe("funding-1");
    expect(channel.deposit).toMatchObject({
      address: BURNER,
      amount: 200_000_000_000n,
      formatted: "20",
      assetSymbol: "DOT",
      payUrl: "https://pay.meld/x",
    });
    expect(widgetUrl).toBe("https://pay.meld/x");

    // Core re-attaches a channel only while more than 2h remain.
    expect(channel.deposit.expiresAt - Date.now()).toBeGreaterThan(2 * 60 * 60 * 1000);
  });

  it("uses the rail's own expiry when the adapter published one", async () => {
    const at = Date.now() + 9 * 60 * 60 * 1000;
    const client: MeldClientLike = {
      getQuote: async () => ({ quotes: [] }),
      createSession: async () => ({
        fundingRequestId: "funding-1",
        sessionId: "meld-sess-1",
        externalSessionId: "ext",
        widgetUrl: "https://pay.meld/x",
        expiresAt: at,
      }),
      getStatus: async () => ({ status: "session_opened" }),
    };
    const { channel } = await requestMeldDeposit(client, args(meldQuote()));

    // A real expiry wins over the fallback window.
    expect(channel.deposit.expiresAt).toBe(at);
  });

  it("rejects a quote that did not come from the Meld rail (no raw provider/context)", async () => {
    const { client } = capturingClient();
    const bad: Quote = { sourceId: "dot-assethub", source: meldQuote().source, raw: {} };
    await expect(requestMeldDeposit(client, args(bad))).rejects.toThrow(/needs a Meld quote/);
  });
});
