import { describe, expect, it } from "vitest";
import { TOKENS, type ReverseQuoteInput } from "@getsome/core";
import type { MeldClientLike, MeldQuoteEntry, MeldSessionRequest } from "./client";
import type { MeldQuoteRaw } from "./quote";
import { createMeldRail } from "./rail";

const BURNER = "5EphemeralBurnerAddressxxxxxxxxxxxxxxxxxxxxxxxxxxx";

function fakeClient(over: Partial<MeldClientLike> = {}): MeldClientLike {
  const quotes: MeldQuoteEntry[] = [
    { serviceProvider: "TRANSAK", sourceAmount: "141.89", destinationAmount: "20.63" },
  ];
  return {
    getQuote: async () => ({ quotes }),
    createSession: async () => ({
      fundingRequestId: "funding-1",
      sessionId: "meld-sess-1",
      externalSessionId: "ext-1",
      widgetUrl: "https://pay.meld/x",
    }),
    getStatus: async () => ({ status: "session_opened" }),
    cancel: async () => ({ outcome: "cancelled" as const }),
    ...over,
  };
}

const twentyDot = (): ReverseQuoteInput => ({
  sourceId: "dot-assethub",
  target: { amount: 200_000_000_000n, decimals: 10 },
});

describe("createMeldRail", () => {
  it("advertises one native Asset Hub source labelled by method", () => {
    const rail = createMeldRail({ client: fakeClient(), country: "US", method: "BANK_TRANSFER" });
    const sources = rail.sources();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      sourceId: "meld-bank",
      chain: "AssetHub",
      asset: "DOT",
      decimals: 10,
    });
    expect(sources[0]?.displayName).toContain("Bank transfer");
  });

  it("sizes, formats and asks Meld for the configured token, not the native", async () => {
    // The trap this guards: a 6-dec asset on the wire while the app sizes it as 10-dec.
    const sentQuote: string[] = [];
    let sentSession: MeldSessionRequest | undefined;
    const client = fakeClient({
      getQuote: async (req) => {
        sentQuote.push(req.destinationCurrencyCode);
        return {
          quotes: [
            { serviceProvider: "TRANSAK", sourceAmount: "20.71", destinationAmount: "20.1" },
          ],
        };
      },
      createSession: async (req) => {
        sentSession = req;
        return {
          fundingRequestId: "funding-1",
          sessionId: "meld-sess-1",
          externalSessionId: "ext-1",
          widgetUrl: "https://pay.meld/x",
        };
      },
    });
    const rail = createMeldRail({ client, country: "US", token: TOKENS.USDT });
    expect(rail.sources()[0]).toMatchObject({ asset: "USDT", decimals: 6 });

    // A 10-dec target narrows to 6-dec USDT units, rounded up so it never under-targets.
    const quote = await rail.getQuote({
      sourceId: "dot-assethub",
      target: { amount: 200_000_000_001n, decimals: 10 },
    });
    expect(quote.source).toEqual({
      amount: 20_000_001n,
      formatted: "20.000001",
      assetSymbol: "USDT",
      decimals: 6,
    });
    expect(sentQuote).toEqual(["USDT_ASSETHUB"]);

    await rail.requestDepositAddress({ quote, destAddress: BURNER, refundAddress: "" });
    expect(sentSession?.destinationCurrencyCode).toBe("USDT_ASSETHUB");
  });

  it("quotes through Meld with the rail-configured country/fiat/method", async () => {
    let sentMethod: string | undefined;
    const client = fakeClient({
      getQuote: async (req) => {
        sentMethod = req.paymentMethodType;
        return {
          quotes: [
            { serviceProvider: "TRANSAK", sourceAmount: "141.89", destinationAmount: "20.63" },
          ],
        };
      },
    });
    const rail = createMeldRail({ client, country: "BR", fiat: "USD", method: "CARD" });
    const quote = await rail.getQuote(twentyDot());
    // Card maps to Meld's real payment-method code on the wire.
    expect(sentMethod).toBe("CREDIT_DEBIT_CARD");
    expect((quote.raw as MeldQuoteRaw).provider.serviceProvider).toBe("TRANSAK");
  });

  it("exposes the hosted pay URL only after a channel is opened", async () => {
    const rail = createMeldRail({ client: fakeClient(), country: "US" });
    expect(rail.payUrl("funding-1")).toBeUndefined();

    const quote = await rail.getQuote(twentyDot());
    const channel = await rail.requestDepositAddress({
      quote,
      destAddress: BURNER,
      refundAddress: "",
    });

    expect(channel.depositChannelId).toBe("funding-1");
    expect(channel.deposit.address).toBe(BURNER);
    expect(rail.payUrl("funding-1")).toBe("https://pay.meld/x");
  });

  it("normalizes status through the rail", async () => {
    const rail = createMeldRail({
      client: fakeClient({ getStatus: async () => ({ status: "settled" }) }),
      country: "US",
    });
    expect((await rail.getStatus("funding-1")).status).toBe("complete");
  });

  it("BANK_TRANSFER also opens a Meld session (widget), like card", async () => {
    let sentMethod: string | undefined;
    const client = fakeClient({
      getQuote: async (req) => {
        sentMethod = req.paymentMethodType;
        return {
          quotes: [
            { serviceProvider: "TRANSAK", sourceAmount: "141.89", destinationAmount: "20.63" },
          ],
        };
      },
    });
    // Bank is region-specific: the app resolves the rail code (here SEPA for DE) and passes it.
    const rail = createMeldRail({
      client,
      country: "DE",
      fiat: "EUR",
      method: "BANK_TRANSFER",
      paymentMethodType: "SEPA",
    });
    const quote = await rail.getQuote(twentyDot());
    const channel = await rail.requestDepositAddress({
      quote,
      destAddress: BURNER,
      refundAddress: "",
    });

    expect(sentMethod).toBe("SEPA");
    expect(channel.depositChannelId).toBe("funding-1");
    expect(channel.deposit.payUrl).toBe("https://pay.meld/x");
    expect(rail.payUrl("funding-1")).toBe("https://pay.meld/x");
  });

  it("reports available liquidity (route availability is enforced at quote time)", async () => {
    const rail = createMeldRail({ client: fakeClient(), country: "US" });
    expect((await rail.probeLiquidity("dot-assethub")).status).toBe("available");
  });
});
