// The sale's side of the Meld boundary: what the client sends the adapter for a sell, what it reads
// back, the offline script, and the sale as the withdrawal's rail leg sees it.

import { describe, expect, it } from "vitest";
import { createMeldClient } from "./client";
import { createFakeMeldClient } from "./fake";
import { formatSellAmount, saleChannelOf, saleStatusView, sellAmountOf, SELL_TOKEN } from "./sell";
import { parseBaseUnits } from "./units";

/** A fetch stub answering a scripted sequence, one response per call, the last repeating. */
function stubSequence(responses: readonly { status: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(JSON.stringify(next?.body ?? {}), {
      status: next?.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const body = (call: { init: RequestInit | undefined }) =>
  JSON.parse(String(call.init?.body)) as Record<string, unknown>;

const SELL_REQ = {
  serviceProvider: "TRANSAK",
  orderRef: "5KeyAddress",
  country: "DE",
  sourceCurrencyCode: "DOT_ASSETHUB",
  sourceAmount: "23.4521",
  destinationCurrencyCode: "EUR",
  paymentMethodType: "SEPA",
};

const created = {
  status: 201,
  body: {
    fundingRequestId: "funding-sell-1",
    sessionId: "s1",
    serviceProviderWidgetUrl: "https://kyc.test",
  },
};

describe("createMeldClient sell quotes", () => {
  it("asks the quote route for a sale, the crypto leg named as the adapter names it", async () => {
    const { impl, calls } = stubSequence([
      {
        status: 200,
        body: {
          quotes: [
            {
              serviceProvider: "TRANSAK",
              sourceAmount: 23.4521,
              destinationAmount: 90.12,
              totalFee: 3.1,
            },
          ],
        },
      },
    ]);
    const client = createMeldClient({ baseUrl: "https://adapter.test/", fetchImpl: impl });
    const { quotes } = await client.getSellQuote({
      country: "DE",
      sourceCurrencyCode: "DOT_ASSETHUB",
      sourceAmount: "23.4521",
      destinationCurrencyCode: "EUR",
      paymentMethodType: "SEPA",
    });
    expect(calls[0]!.url).toBe("https://adapter.test/quote");
    expect(body(calls[0]!)).toEqual({
      direction: "sell",
      country: "DE",
      fiat: "EUR",
      destinationCurrencyCode: "DOT_ASSETHUB",
      // Never `sourceAmount`, which the adapter validates as fiat.
      cryptoAmount: "23.4521",
      paymentMethodType: "SEPA",
    });
    expect(quotes).toEqual([
      {
        serviceProvider: "TRANSAK",
        sourceAmount: "23.4521",
        destinationAmount: "90.12",
        totalFee: "3.1",
      },
    ]);
  });
});

describe("createMeldClient sell sessions", () => {
  it("opens a sale for the committed crypto, naming no wallet", async () => {
    const { impl, calls } = stubSequence([created]);
    const client = createMeldClient({
      baseUrl: "https://adapter.test",
      redirectUrl: "https://adapter.test/meld/return",
      fetchImpl: impl,
    });
    const session = await client.createSellSession(SELL_REQ);
    expect(calls[0]!.url).toBe("https://adapter.test/session");
    const sent = body(calls[0]!);
    expect(sent).toMatchObject({
      direction: "sell",
      country: "DE",
      fiat: "EUR",
      destinationCurrencyCode: "DOT_ASSETHUB",
      cryptoAmount: "23.4521",
      paymentMethodType: "SEPA",
      serviceProvider: "TRANSAK",
      redirectUrl: "https://adapter.test/meld/return",
    });
    // Optional on a sale at Meld, and refused by the adapter.
    expect(sent).not.toHaveProperty("walletAddress");
    // The order reference is key material, not a term the adapter is told.
    expect(sent).not.toHaveProperty("orderRef");
    expect(String(sent.idempotencyKey)).toContain("sell");
    expect(String(sent.idempotencyKey)).toContain(SELL_REQ.orderRef);
    expect(session).toMatchObject({
      fundingRequestId: "funding-sell-1",
      widgetUrl: "https://kyc.test",
    });
  });

  it("keeps a buy and a sale of one pair on different keys", async () => {
    const { impl, calls } = stubSequence([created]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });
    await client.createSellSession(SELL_REQ);
    await client.createSession({
      serviceProvider: "TRANSAK",
      country: "DE",
      sourceCurrencyCode: "EUR",
      sourceAmount: "90.00",
      destinationCurrencyCode: "DOT_ASSETHUB",
      destinationAmount: "23",
      walletAddress: SELL_REQ.orderRef,
      paymentMethodType: "SEPA",
    });
    expect(body(calls[0]!).idempotencyKey).not.toBe(body(calls[1]!).idempotencyKey);
  });

  it("refuses to resume into a sale opened for another amount", async () => {
    const { impl } = stubSequence([
      {
        status: 409,
        body: {
          error: {
            tag: "Other",
            value: {
              code: "IDEMPOTENCY_KEY_REUSED",
              message: "reused",
              fundingRequestId: "funding-live",
            },
          },
        },
      },
      {
        status: 200,
        body: {
          funding: {
            status: "session_opened",
            serviceProviderWidgetUrl: "https://kyc.test/resume",
            fiat: "EUR",
            destinationCurrencyCode: "DOT_ASSETHUB",
            cryptoAmount: "50",
          },
        },
      },
    ]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });
    await expect(client.createSellSession(SELL_REQ)).rejects.toThrow(/different order/);
  });

  it("resumes the same sale under the same key", async () => {
    const { impl } = stubSequence([
      {
        status: 409,
        body: {
          error: {
            tag: "Other",
            value: {
              code: "IDEMPOTENCY_KEY_REUSED",
              message: "reused",
              fundingRequestId: "funding-live",
            },
          },
        },
      },
      {
        status: 200,
        body: {
          funding: {
            status: "session_opened",
            serviceProviderWidgetUrl: "https://kyc.test/resume",
            fiat: "EUR",
            destinationCurrencyCode: "DOT_ASSETHUB",
            cryptoAmount: "23.4521",
          },
        },
      },
    ]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });
    const session = await client.createSellSession(SELL_REQ);
    expect(session).toMatchObject({
      fundingRequestId: "funding-live",
      widgetUrl: "https://kyc.test/resume",
    });
  });
});

describe("createMeldClient sell status", () => {
  const funding = (deposit: Record<string, unknown> | undefined) => ({
    status: 200,
    body: {
      funding: {
        status: "transaction_seen",
        direction: "sell",
        cryptoAmount: "23.4521",
        ...(deposit === undefined ? {} : { deposit }),
      },
    },
  });

  it("reads the deposit terms the adapter discloses", async () => {
    const { impl } = stubSequence([
      funding({
        address: "14Kt4HmnCzMqUKvWcGZdLaWkLNcL4TcUSXYvKyKdbMhsvRxM",
        amount: "23.4521",
        currency: "DOT_ASSETHUB",
        observedAt: 1_800,
      }),
    ]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });
    expect(await client.getStatus("funding-sell-1")).toEqual({
      status: "transaction_seen",
      direction: "sell",
      cryptoAmount: "23.4521",
      deposit: {
        address: "14Kt4HmnCzMqUKvWcGZdLaWkLNcL4TcUSXYvKyKdbMhsvRxM",
        amount: "23.4521",
        currency: "DOT_ASSETHUB",
        observedAt: 1_800,
      },
    });
  });

  it("takes half a disclosure as none", async () => {
    for (const deposit of [
      { address: "", amount: "23.4521", currency: "DOT_ASSETHUB", observedAt: 1 },
      { address: "14Kt", amount: "", currency: "DOT_ASSETHUB", observedAt: 1 },
      { address: "14Kt", amount: "1", currency: "", observedAt: 1 },
      { address: "14Kt", amount: "1", currency: "DOT_ASSETHUB" },
    ]) {
      const { impl } = stubSequence([funding(deposit)]);
      const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });
      expect(await client.getStatus("funding-sell-1")).not.toHaveProperty("deposit");
    }
  });
});

describe("the offline sale", () => {
  it("answers KYC polls first, then discloses the deposit for the committed amount", async () => {
    const client = createFakeMeldClient({ sellPollsBeforeDeposit: 2 });
    const session = await client.createSellSession(SELL_REQ);
    expect((await client.getStatus(session.fundingRequestId)).deposit).toBeUndefined();
    expect((await client.getStatus(session.fundingRequestId)).deposit).toBeUndefined();
    const disclosed = await client.getStatus(session.fundingRequestId);
    expect(disclosed.deposit).toMatchObject({ amount: "23.4521", currency: "DOT_ASSETHUB" });
    // Once the address is out the sale cannot be withdrawn.
    expect(await client.cancel(session.fundingRequestId)).toEqual({ outcome: "not-cancellable" });
  });

  it("stops disclosing anything for a sale cancelled during KYC", async () => {
    const client = createFakeMeldClient({ sellPollsBeforeDeposit: 1 });
    const session = await client.createSellSession(SELL_REQ);
    expect(await client.cancel(session.fundingRequestId)).toEqual({ outcome: "cancelled" });
    for (let i = 0; i < 3; i += 1) {
      expect((await client.getStatus(session.fundingRequestId)).deposit).toBeUndefined();
    }
  });

  it("quotes a sale crypto in, fiat out, the fees off the payout", async () => {
    const client = createFakeMeldClient({ usdPerToken: 4, feePct: 2 });
    const { quotes } = await client.getSellQuote({
      country: "DE",
      sourceCurrencyCode: "DOT_ASSETHUB",
      sourceAmount: "10",
      destinationCurrencyCode: "EUR",
      paymentMethodType: "SEPA",
    });
    // 40 gross, 0.8 + 0.5 in fees.
    expect(quotes[0]).toMatchObject({
      sourceAmount: "10",
      destinationAmount: "38.70",
      totalFee: "1.30",
    });
  });
});

describe("the sale as the rail leg reads it", () => {
  const disclosed = {
    status: "transaction_seen",
    deposit: { address: "14Kt", amount: "23.4521", currency: "DOT_ASSETHUB", observedAt: 1 },
  };

  it("is a channel to an address for an exact figure, paid out off chain", () => {
    expect(saleChannelOf(disclosed)).toEqual({
      depositAddress: "14Kt",
      payout: "off-chain",
      expired: false,
      expectedAmount: 234_521_000_000n,
    });
  });

  it("is closed once the adapter concludes it", () => {
    expect(saleChannelOf({ ...disclosed, status: "expired" })?.expired).toBe(true);
  });

  it("is no channel without a disclosure, for another asset, or for an unreadable amount", () => {
    expect(saleChannelOf({ status: "session_opened" })).toBeNull();
    expect(
      saleChannelOf({ ...disclosed, deposit: { ...disclosed.deposit, currency: "USDT_ASSETHUB" } }),
    ).toBeNull();
    expect(
      saleChannelOf({ ...disclosed, deposit: { ...disclosed.deposit, amount: "1.00000000001" } }),
    ).toBeNull();
  });

  it("follows the payout to its end in the seller's words", () => {
    expect(saleStatusView({ status: "settled" }).status).toBe("complete");
    expect(saleStatusView({ status: "transaction_seen" }).status).toBe("receiving");
    const refunded = saleStatusView({ status: "failed", providerStatus: "REFUNDED" });
    expect(refunded.status).toBe("failed");
    expect(refunded.depositFailure?.reason).toMatchObject({ code: "refunded" });
    expect(saleStatusView({ status: "expired" }).depositFailure?.reason?.message).toMatch(/closed/);
  });
});

describe("sale amounts", () => {
  it("cuts a figure to the sale's decimals, never up", () => {
    expect(sellAmountOf(234_521_987_654n)).toBe(234_521_000_000n);
    expect(formatSellAmount(234_521_000_000n)).toBe("23.4521");
  });

  it("parses a decimal exactly, refusing more precision than the token has", () => {
    expect(parseBaseUnits(SELL_TOKEN, "23.4521")).toBe(234_521_000_000n);
    expect(parseBaseUnits(SELL_TOKEN, "7")).toBe(70_000_000_000n);
    expect(parseBaseUnits(SELL_TOKEN, "0.00000000001")).toBeNull();
    expect(parseBaseUnits(SELL_TOKEN, "-1")).toBeNull();
    expect(parseBaseUnits(SELL_TOKEN, "1e3")).toBeNull();
  });
});
