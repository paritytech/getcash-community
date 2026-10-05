// The sale's side of the Meld boundary: what the client sends the adapter for a sell, what it reads
// back, the offline script, and the sale as the withdrawal's rail leg sees it.

import { describe, expect, it } from "vitest";
import { createMeldClient } from "./client";
import { createFakeMeldClient } from "./fake";
import type { MeldClientLike, MeldQuoteEntry, MeldStatusResult } from "./client";
import {
  formatSellAmount,
  SALE_GONE_AFTER,
  SALE_GONE_FOR_MS,
  saleChannelOf,
  saleRail,
  saleStatusView,
  sellAmountOf,
  sellQuoteUsable,
  SELL_TOKEN,
  type SaleReadMemory,
} from "./sell";
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

  it("reads when the provider named another address, which the adapter then stops disclosing", async () => {
    const conflicted = (depositConflictAt: unknown) => ({
      status: 200,
      body: { funding: { status: "transaction_seen", direction: "sell", depositConflictAt } },
    });
    const { impl } = stubSequence([conflicted(1_900), conflicted("1900")]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });
    expect(await client.getStatus("funding-sell-1")).toEqual({
      status: "transaction_seen",
      depositConflictAt: 1_900,
    });
    expect(await client.getStatus("funding-sell-1")).not.toHaveProperty("depositConflictAt");
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

  it("tags its sale ids when asked, and ends a sale it never opened", async () => {
    const client = createFakeMeldClient({ saleIdTag: "load2" });
    expect((await client.createSellSession(SELL_REQ)).fundingRequestId).toBe("mock-sell-load2-1");
    // Opened by an earlier load of the page, whose memory is gone.
    expect(await client.getStatus("mock-sell-load1-1")).toEqual({ status: "expired" });
    // A buy it does not know still reads as the fixed status.
    expect(await client.getStatus("funding-1")).toEqual({ status: "session_opened" });
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

  it("reads trailing zeros as no value, as a provider may pad its amount", () => {
    expect(parseBaseUnits(SELL_TOKEN, "23.452100000000000000")).toBe(234_521_000_000n);
    expect(parseBaseUnits(SELL_TOKEN, "7.0")).toBe(70_000_000_000n);
    expect(parseBaseUnits(SELL_TOKEN, "7.")).toBe(70_000_000_000n);
    expect(parseBaseUnits(SELL_TOKEN, "0.00000000010")).toBe(1n);
    // A digit past the token's own is still refused, however it is padded.
    expect(parseBaseUnits(SELL_TOKEN, "0.000000000010")).toBeNull();
    expect(parseBaseUnits(SELL_TOKEN, "0.00000000001")).toBeNull();
  });
});

describe("the sale's reads for the worker", () => {
  const live: MeldStatusResult = {
    status: "transaction_seen",
    deposit: {
      address: "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5",
      amount: "23.4521",
      currency: "DOT_ASSETHUB",
      observedAt: 1,
    },
  };
  const notFound = Object.assign(new Error("not found"), { status: 404 });

  /** A client whose `getStatus` answers from `script`, one entry per call, an Error thrown. */
  function scripted(script: readonly (MeldStatusResult | Error)[]): MeldClientLike {
    let call = 0;
    return {
      getStatus: async () => {
        const next = script[Math.min(call, script.length - 1)]!;
        call += 1;
        if (next instanceof Error) throw next;
        return next;
      },
    } as unknown as MeldClientLike;
  }

  it("reads the channel and the status through the adapter", async () => {
    const rail = saleRail(scripted([live, { status: "settled" }]), {});
    expect(await rail.channel("funding-1")).toMatchObject({ expectedAmount: 234_521_000_000n });
    expect(await rail.status("funding-1")).toMatchObject({ status: "complete" });
  });

  it("takes a sale the adapter keeps answering 404 for as gone, and only then", async () => {
    const memory: SaleReadMemory = {};
    let clock = 1_000_000;
    const rail = saleRail(scripted([notFound]), memory, () => clock);
    for (let read = 1; read < SALE_GONE_AFTER; read += 1) {
      await expect(rail.channel("funding-1")).rejects.toBe(notFound);
      expect(memory.saleNotFound).toBe(read);
      clock += 60_000;
    }
    // Enough answers, but not for long enough: an adapter restarting is not a lost sale.
    clock = 1_000_000 + SALE_GONE_FOR_MS - 1;
    await expect(rail.channel("funding-1")).rejects.toBe(notFound);
    clock = 1_000_000 + SALE_GONE_FOR_MS;
    // No channel to pay: the leg fails it as a mismatch and the key goes home.
    expect(await rail.channel("funding-1")).toBeNull();
    expect(memory.saleNotFoundSince).toBe(1_000_000);
    // Once paid, a payout nobody can confirm.
    expect(await rail.status("funding-1")).toMatchObject({
      status: "failed",
      depositFailure: { reason: { code: "unobserved" } },
    });
  });

  it("starts the count again after an answer, and throws any other failure as it is", async () => {
    const memory: SaleReadMemory = {};
    const boom = Object.assign(new Error("bad gateway"), { status: 502 });
    const rail = saleRail(scripted([notFound, notFound, live, notFound, boom]), memory);
    await expect(rail.channel("funding-1")).rejects.toBe(notFound);
    await expect(rail.channel("funding-1")).rejects.toBe(notFound);
    expect(await rail.channel("funding-1")).not.toBeNull();
    expect(memory.saleNotFound).toBeUndefined();
    expect(memory.saleNotFoundSince).toBeUndefined();
    await expect(rail.channel("funding-1")).rejects.toBe(notFound);
    expect(memory.saleNotFound).toBe(1);
    await expect(rail.channel("funding-1")).rejects.toBe(boom);
    expect(memory.saleNotFound).toBe(1);
  });
});

describe("which quote lines can carry a sale", () => {
  const line = (serviceProvider: string, destinationAmount = "90.12"): MeldQuoteEntry => ({
    serviceProvider,
    sourceAmount: "23.4521",
    destinationAmount,
  });

  it("keeps the providers that send the seller back, and drops the standard-flow ones", () => {
    for (const name of ["TRANSAK", "BANXA", "ALCHEMYPAY", "REVOLUT", "UNLIMIT"]) {
      expect(sellQuoteUsable(line(name))).toBe(true);
    }
    for (const name of ["COINBASEPAY", "COINBASE_PAY", "Koywe", "PAYBIS", "ROBINHOOD"]) {
      expect(sellQuoteUsable(line(name))).toBe(false);
    }
  });

  it("drops a payout that is not a positive number", () => {
    for (const payout of ["", "0", "-1", "abc"]) {
      expect(sellQuoteUsable(line("TRANSAK", payout))).toBe(false);
    }
  });
});
