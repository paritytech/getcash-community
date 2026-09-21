// Error mapping and idempotency-key behavior of `createMeldClient`.

import { describe, expect, it } from "vitest";
import { createMeldClient } from "./client";

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

const concluded = {
  status: 409,
  body: { error: { tag: "Other", value: { code: "REQUEST_CONCLUDED", message: "concluded" } } },
};
const outcomeUnknown = {
  status: 409,
  body: { error: { tag: "Other", value: { code: "REQUEST_OUTCOME_UNKNOWN", message: "unknown" } } },
};
const inFlight = {
  status: 409,
  // The adapter's answer while the session create is still in flight.
  body: {
    error: { tag: "Other", value: { code: "REQUEST_IN_FLIGHT", message: "still being opened" } },
  },
};
const alreadySettled = {
  status: 409,
  // The adapter's answer for a purchase the buyer has already paid for.
  body: {
    error: { tag: "Other", value: { code: "REQUEST_ALREADY_SETTLED", message: "already paid" } },
  },
};
const keyReused = {
  status: 409,
  // The adapter's answer when the same key arrives with a different fiat amount. It names the
  // existing row.
  body: {
    error: {
      tag: "Other",
      value: {
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "different request",
        fundingRequestId: "funding-live",
      },
    },
  },
};
const created = {
  status: 201,
  body: {
    fundingRequestId: "funding-9",
    sessionId: "s9",
    serviceProviderWidgetUrl: "https://pay.test",
  },
};

/** A fetch stub answering one canned response, capturing what was sent. */
function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const SESSION_REQ = {
  serviceProvider: "TRANSAK",
  country: "US",
  sourceCurrencyCode: "USD",
  sourceAmount: "136.86",
  destinationCurrencyCode: "DOT_ASSETHUB",
  destinationAmount: "153.5",
  walletAddress: "13ENScfFZXQ8avXf6cphack516B8YCjdL4MJbodm7VxK8GE9",
  paymentMethodType: "CREDIT_DEBIT_CARD",
};

/** The sell mirror of SESSION_REQ: crypto out, fiat in, and no wallet address. */
const SELL_SESSION_REQ = {
  serviceProvider: "TRANSAK",
  // The withdrawal's burner address. Key material only; it never reaches the wire.
  orderRef: "13ENScfFZXQ8avXf6cphack516B8YCjdL4MJbodm7VxK8GE9",
  country: "US",
  sourceCurrencyCode: "DOT_ASSETHUB",
  sourceAmount: "153.5",
  destinationCurrencyCode: "USD",
  destinationAmount: "136.86",
  paymentMethodType: "ACH",
};

const liveFunding = {
  status: 200,
  body: {
    funding: {
      status: "session_opened",
      serviceProviderWidgetUrl: "https://pay.test/resume",
      expiresAt: 1_800_000_000_000,
      walletAddress: SESSION_REQ.walletAddress,
      fiat: SESSION_REQ.sourceCurrencyCode,
      destinationCurrencyCode: SESSION_REQ.destinationCurrencyCode,
      // Priced when the row was opened; the rate has moved since.
      sourceAmount: "134.02",
    },
  },
};
const wrongOrderFunding = {
  status: 200,
  // A live row for a different burner: a different purchase.
  body: {
    funding: {
      status: "session_opened",
      serviceProviderWidgetUrl: "https://pay.test/other",
      walletAddress: "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5",
      fiat: SESSION_REQ.sourceCurrencyCode,
      destinationCurrencyCode: SESSION_REQ.destinationCurrencyCode,
      sourceAmount: "136.86",
    },
  },
};
const concludedFunding = {
  status: 200,
  // Terminal: the adapter answers 200 but withholds the pay page.
  body: { funding: { status: "settled" } },
};
describe("createMeldClient quote mapping", () => {
  const QUOTE_REQ = {
    country: "GB",
    sourceCurrencyCode: "GBP",
    destinationCurrencyCode: "DOT_ASSETHUB",
    sourceAmount: "50.00",
    paymentMethodType: "CREDIT_DEBIT_CARD",
  };

  it("keeps every fee component the quote line carries", async () => {
    // A real GB card line: the fee splits into the provider's own fee and our cut, and no network
    // fee is quoted. The breakdown can only show what survives this mapping, so dropping a
    // component here silently mis-attributes it — `partnerFee` folded into the provider's fee is
    // exactly the bug that shipped.
    const { impl } = stubFetch(200, {
      quotes: [
        {
          serviceProvider: "TRANSAK",
          sourceAmount: "50",
          destinationAmount: "62.1658228",
          totalFee: "3.25",
          transactionFee: "2.75",
          networkFee: null,
          partnerFee: "0.5",
          customerScore: "90.43",
        },
      ],
    });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });
    const { quotes } = await client.getQuote(QUOTE_REQ);
    expect(quotes[0]).toMatchObject({
      serviceProvider: "TRANSAK",
      totalFee: "3.25",
      transactionFee: "2.75",
      partnerFee: "0.5",
    });
    // A null component is absent, not the string "null": the breakdown keys its rows off presence.
    expect(quotes[0]).not.toHaveProperty("networkFee");
  });

  it("omits components the quote line does not carry at all", async () => {
    const { impl } = stubFetch(200, {
      quotes: [
        { serviceProvider: "KOYWE", sourceAmount: "50", destinationAmount: "60", totalFee: "3" },
      ],
    });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });
    const { quotes } = await client.getQuote(QUOTE_REQ);
    expect(quotes[0]).not.toHaveProperty("transactionFee");
    expect(quotes[0]).not.toHaveProperty("partnerFee");
  });
});

describe("createMeldClient error mapping", () => {
  it("carries the adapter's own code through the `Other` catch-all", async () => {
    const { impl } = stubFetch(400, {
      error: { tag: "Other", value: { code: "REDIRECT_NOT_ALLOWED", message: "Nope." } },
    });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });
    await expect(client.createSession(SESSION_REQ)).rejects.toThrow(/REDIRECT_NOT_ALLOWED/);
  });

  it("does not blame the quote when the session create is what failed", async () => {
    const { impl } = stubFetch(400, {
      error: { tag: "Other", value: { code: "MALFORMED_REQUEST", message: "Bad request." } },
    });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });
    await expect(client.createSession(SESSION_REQ)).rejects.not.toThrow(/quote/i);
  });

  it("names the threshold on BelowMinimum", async () => {
    const { impl } = stubFetch(400, {
      error: { tag: "BelowMinimum", value: { amount: "5.00", currency: "USD" } },
    });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });
    await expect(
      client.getQuote({
        country: "US",
        sourceCurrencyCode: "USD",
        destinationCurrencyCode: "DOT_ASSETHUB",
        sourceAmount: "1.00",
        paymentMethodType: "CREDIT_DEBIT_CARD",
      }),
    ).rejects.toThrow(/5\.00 USD/);
  });

  it("names the failing call for a tag it does not know", async () => {
    const { impl } = stubFetch(500, { error: { tag: "SomethingNew" } });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });
    await expect(client.createSession(SESSION_REQ)).rejects.toThrow(/Starting the payment/);
  });

  it("omits redirectUrl when none is configured", async () => {
    const { impl, calls } = stubFetch(201, {
      fundingRequestId: "funding-1",
      sessionId: "s1",
      serviceProviderWidgetUrl: "https://pay.test",
    });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });
    await client.createSession(SESSION_REQ);
    const sent = JSON.parse(String(calls[0]?.init?.body));
    expect(sent).not.toHaveProperty("redirectUrl");
  });

  it("refuses a session the adapter did not give a fundingRequestId", async () => {
    const { impl } = stubFetch(201, {
      sessionId: "s1",
      serviceProviderWidgetUrl: "https://pay.test",
    });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    await expect(client.createSession(SESSION_REQ)).rejects.toThrow(/fundingRequestId/);
  });

  it("refuses a session the adapter gave no pay page for", async () => {
    const { impl } = stubFetch(201, { fundingRequestId: "funding-9", sessionId: "s9" });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    await expect(client.createSession(SESSION_REQ)).rejects.toThrow(/no pay page/);
  });

  it("accepts a session that has only Meld's own widget URL", async () => {
    // One of the two URLs is enough.
    const { impl } = stubFetch(201, {
      fundingRequestId: "funding-9",
      sessionId: "s9",
      widgetUrl: "https://sb.meldcrypto.com/?session=s9",
    });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    const session = await client.createSession(SESSION_REQ);
    expect(session.meldWidgetUrl).toBe("https://sb.meldcrypto.com/?session=s9");
    expect(session.widgetUrl).toBe("");
  });

  it("derives a reload-stable idempotency key from the purchase intent", async () => {
    const first = stubFetch(201, {
      fundingRequestId: "funding-1",
      sessionId: "s1",
      serviceProviderWidgetUrl: "https://pay.test",
    });
    const second = stubFetch(201, {
      fundingRequestId: "funding-1",
      sessionId: "s1",
      serviceProviderWidgetUrl: "https://pay.test",
    });

    await createMeldClient({
      baseUrl: "https://adapter.test",
      fetchImpl: first.impl,
    }).createSession(SESSION_REQ);
    await createMeldClient({
      baseUrl: "https://adapter.test",
      fetchImpl: second.impl,
    }).createSession(SESSION_REQ);

    // A fresh client, as after a reload, sends the same key for the same intent.
    const a = JSON.parse(String(first.calls[0]?.init?.body)).idempotencyKey;
    const b = JSON.parse(String(second.calls[0]?.init?.body)).idempotencyKey;
    expect(a).toBe(b);
    expect(a).toContain(SESSION_REQ.walletAddress);

    // A different burner is a different purchase, and a different key.
    const other = stubFetch(201, {
      fundingRequestId: "funding-2",
      sessionId: "s2",
      serviceProviderWidgetUrl: "https://pay.test",
    });
    await createMeldClient({
      baseUrl: "https://adapter.test",
      fetchImpl: other.impl,
    }).createSession({
      ...SESSION_REQ,
      walletAddress: "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5",
    });
    expect(JSON.parse(String(other.calls[0]?.init?.body)).idempotencyKey).not.toBe(a);
  });

  it("does not move the key when the quote re-solves at a different rate", async () => {
    // The solved fiat amount, provider and destination amount all move between probes. None of
    // them may reach the key.
    const keyAt = async (
      sourceAmount: string,
      serviceProvider: string,
      destinationAmount: string,
    ) => {
      const { impl, calls } = stubSequence([created]);
      await createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl }).createSession({
        ...SESSION_REQ,
        sourceAmount,
        serviceProvider,
        destinationAmount,
      });
      return String(JSON.parse(String(calls[0]?.init?.body)).idempotencyKey);
    };

    expect(await keyAt("2.89", "TRANSAK", "150.4")).toBe(await keyAt("2.88", "BANXA", "149.9"));
  });

  it("starts a new attempt when the adapter says the last one concluded", async () => {
    // Each `REQUEST_CONCLUDED` advances the attempt suffix, minting a new key.
    const { impl, calls } = stubSequence([concluded, concluded, created]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    const session = await client.createSession(SESSION_REQ);

    expect(session.fundingRequestId).toBe("funding-9");
    const keys = calls.map((c) => JSON.parse(String(c.init?.body)).idempotencyKey);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
    // Same intent throughout; only the attempt moves.
    for (const k of keys) expect(k).toContain(SESSION_REQ.walletAddress);
  });

  it("does NOT start a new attempt when the outcome is unknown", async () => {
    // `REQUEST_OUTCOME_UNKNOWN` means the adapter could not rule out that a payment happened.
    const { impl, calls } = stubSequence([outcomeUnknown, created]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    await expect(client.createSession(SESSION_REQ)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("does NOT walk past a request that is still being opened", async () => {
    // `REQUEST_IN_FLIGHT` means the session create is still running. The walk stops.
    const { impl, calls } = stubSequence([inFlight, created]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    await expect(client.createSession(SESSION_REQ)).rejects.toThrow();
    expect(calls).toHaveLength(1);
    // Asserts on the whole suffix; "-1" also appears inside the amount 136.86.
    expect(String(JSON.parse(String(calls[0]?.init?.body)).idempotencyKey).endsWith("-1")).toBe(
      true,
    );
  });

  it("does NOT walk past a purchase the buyer has already paid for", async () => {
    // `REQUEST_ALREADY_SETTLED` is never walked past.
    const { impl, calls } = stubSequence([alreadySettled, created]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    await expect(client.createSession(SESSION_REQ)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("mints a different key for every term the adapter compares", async () => {
    // Terms the buyer chose move the key; terms the quote solved do not.
    const keyFor = async (overrides: Partial<typeof SESSION_REQ>) => {
      const { impl, calls } = stubSequence([created]);
      await createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl }).createSession({
        ...SESSION_REQ,
        ...overrides,
      });
      return String(JSON.parse(String(calls[0]?.init?.body)).idempotencyKey);
    };

    const base = await keyFor({});
    for (const overrides of [
      { paymentMethodType: "BANK_TRANSFER" },
      { country: "DE" },
      { sourceCurrencyCode: "EUR" },
      { destinationCurrencyCode: "USDC_ASSETHUB" },
      { walletAddress: "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5" },
    ]) {
      expect(await keyFor(overrides), `chosen: ${JSON.stringify(overrides)}`).not.toBe(base);
    }
    for (const overrides of [
      { sourceAmount: "99.00" },
      { serviceProvider: "BANXA" },
      // The provider's figure for this quote; it moves with the rate.
      { destinationAmount: "151.2" },
    ]) {
      expect(await keyFor(overrides), `solved: ${JSON.stringify(overrides)}`).toBe(base);
    }

    // The same intent mints the same key.
    expect(await keyFor({})).toBe(base);
  });

  it("re-attaches to the request the adapter named instead of minting a fresh key", async () => {
    // The reload path: the adapter refuses the same key on terms and the client resumes the row
    // it names.
    const { impl, calls } = stubSequence([keyReused, liveFunding]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    const session = await client.createSession(SESSION_REQ);

    expect(session.fundingRequestId).toBe("funding-live");
    expect(session.widgetUrl).toBe("https://pay.test/resume");
    expect(session.expiresAt).toBe(1_800_000_000_000);
    // Two calls: the refused create, then the lookup. Never a second create.
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain("/funding/funding-live");
    expect(calls.filter((c) => c.url.endsWith("/session"))).toHaveLength(1);
  });

  it("refuses a resumed row that is not the purchase it asked about", async () => {
    // A wallet mismatch on the resumed row is a different purchase, not a moved rate.
    const { impl, calls } = stubSequence([keyReused, wrongOrderFunding]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    await expect(client.createSession(SESSION_REQ)).rejects.toThrow(/different order/i);
    // It does not fall through to opening one.
    expect(calls.filter((c) => c.url.endsWith("/session"))).toHaveLength(1);
  });

  it("refuses rather than re-creating when the named request has no surface left", async () => {
    // The row concluded, so `GET /funding/:id` withholds the URL. This fails closed.
    const { impl, calls } = stubSequence([keyReused, concludedFunding]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    await expect(client.createSession(SESSION_REQ)).rejects.toThrow(/do not start another/i);
    expect(calls).toHaveLength(2);
    expect(calls.filter((c) => c.url.endsWith("/session"))).toHaveLength(1);
  });

  it("never walks a caller-supplied key, which is the caller's identity to own", async () => {
    const { impl, calls } = stubSequence([concluded, created]);
    const client = createMeldClient({
      baseUrl: "https://adapter.test",
      fetchImpl: impl,
      idempotencyKey: () => "caller-owns-this",
    });

    await expect(client.createSession(SESSION_REQ)).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]?.init?.body)).idempotencyKey).toBe("caller-owns-this");
  });

  it("gives up rather than walking attempts for ever", async () => {
    const { impl, calls } = stubSequence([concluded]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    await expect(client.createSession(SESSION_REQ)).rejects.toThrow();
    // Exactly MAX_ATTEMPTS: a weaker bound passes for a walk that gave up after one.
    expect(calls.length).toBe(5);
  });

  it("polls the adapter's own funding route, not a session status route", async () => {
    const { impl, calls } = stubFetch(200, {
      funding: {
        status: "session_opened",
        serviceProviderWidgetUrl: "https://pay.test/resume",
        expiresAt: 1_800_000_000_000,
      },
    });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    const result = await client.getStatus("funding-1");

    expect(String(calls[0]?.url)).toBe("https://adapter.test/funding/funding-1");
    expect(result.status).toBe("session_opened");
    // The resume surface travels with the status.
    expect(result.serviceProviderWidgetUrl).toBe("https://pay.test/resume");
    expect(result.expiresAt).toBe(1_800_000_000_000);
  });

  it("carries the provider's own status through, so a refund is distinguishable", async () => {
    const { impl } = stubFetch(200, {
      funding: { status: "failed", providerStatus: "REFUNDED" },
    });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    const result = await client.getStatus("funding-1");

    expect(result.status).toBe("failed");
    expect(result.providerStatus).toBe("REFUNDED");
  });
});

describe("createMeldClient sell quotes", () => {
  const SELL_QUOTE_REQ = {
    country: "US",
    sourceCurrencyCode: "DOT_ASSETHUB",
    sourceAmount: "153.5",
    destinationCurrencyCode: "USD",
    paymentMethodType: "ACH",
  };

  it("asks the quote route for a sell, discriminated by direction", async () => {
    // The crypto leg is `destinationCurrencyCode` even though it is what the seller sends, and
    // the crypto amount travels as `cryptoAmount`: `sourceAmount` is validated as fiat minor
    // units and would truncate ten decimals to two.
    const { impl, calls } = stubFetch(200, { quotes: [] });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    await client.getSellQuote({ ...SELL_QUOTE_REQ, sourceAmount: "24.4123456789" });

    expect(String(calls[0]?.url)).toBe("https://adapter.test/quote");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      direction: "sell",
      country: "US",
      fiat: "USD",
      destinationCurrencyCode: "DOT_ASSETHUB",
      cryptoAmount: "24.4123456789",
      paymentMethodType: "ACH",
    });
  });

  it("leaves a buy quote's body exactly as it was, with no direction on it", async () => {
    // Absent means buy. Sending `direction: "buy"` would be a new field on the oldest body here.
    const { impl, calls } = stubFetch(200, { quotes: [] });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    await client.getQuote({
      country: "GB",
      sourceCurrencyCode: "GBP",
      destinationCurrencyCode: "DOT_ASSETHUB",
      sourceAmount: "50.00",
      paymentMethodType: "CREDIT_DEBIT_CARD",
    });

    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      country: "GB",
      fiat: "GBP",
      destinationCurrencyCode: "DOT_ASSETHUB",
      sourceAmount: "50.00",
      paymentMethodType: "CREDIT_DEBIT_CARD",
    });
  });

  it("keeps every fee component a sell quote line carries", async () => {
    // Same normalization as the buy: a null component is absent rather than the string "null",
    // and the score is coerced off the string Meld sends.
    const { impl } = stubFetch(200, {
      quotes: [
        {
          serviceProvider: "TRANSAK",
          sourceAmount: "153.5",
          destinationAmount: "1030.42",
          totalFee: "12.00",
          transactionFee: "11.50",
          networkFee: null,
          partnerFee: "0.5",
          customerScore: "90.43",
        },
        // Dropped: an offer with no provider cannot be acted on.
        { sourceAmount: "153.5", destinationAmount: "1040.00" },
      ],
    });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    const { quotes } = await client.getSellQuote(SELL_QUOTE_REQ);

    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({
      serviceProvider: "TRANSAK",
      // Crypto in, fiat out — the reverse of a buy line.
      sourceAmount: "153.5",
      destinationAmount: "1030.42",
      totalFee: "12.00",
      transactionFee: "11.50",
      partnerFee: "0.5",
      customerScore: 90.43,
    });
    expect(quotes[0]).not.toHaveProperty("networkFee");
  });

  it("names the threshold on BelowMinimum", async () => {
    const { impl } = stubFetch(400, {
      error: { tag: "BelowMinimum", value: { amount: "10.00", currency: "USD" } },
    });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    await expect(client.getSellQuote(SELL_QUOTE_REQ)).rejects.toThrow(/10\.00 USD/);
  });
});

describe("createMeldClient sell sessions", () => {
  it("opens a sell on the session route and never sends a wallet address", async () => {
    // The provider issues the address on a sell, so sending one would be meaningless — and would
    // read as the buy's delivery address to an adapter that serves both. The committed amount
    // goes as `cryptoAmount`, at full precision; `sourceAmount` and `destinationAmount` are not
    // sent at all, the first because it is fiat-validated and the second because the adapter
    // re-prices.
    const { impl, calls } = stubFetch(201, {
      fundingRequestId: "funding-sell-1",
      sessionId: "s-sell-1",
      serviceProviderWidgetUrl: "https://sell.test",
      expiresAt: 1_800_000_000_000,
    });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    const session = await client.createSellSession(SELL_SESSION_REQ);

    expect(String(calls[0]?.url)).toBe("https://adapter.test/session");
    const sent = JSON.parse(String(calls[0]?.init?.body));
    for (const absent of ["walletAddress", "sourceAmount", "destinationAmount"]) {
      expect(sent, absent).not.toHaveProperty(absent);
    }
    expect(sent).toMatchObject({
      direction: "sell",
      country: "US",
      fiat: "USD",
      destinationCurrencyCode: "DOT_ASSETHUB",
      cryptoAmount: "153.5",
      paymentMethodType: "ACH",
      serviceProvider: "TRANSAK",
    });
    expect(session).toMatchObject({
      fundingRequestId: "funding-sell-1",
      sessionId: "s-sell-1",
      widgetUrl: "https://sell.test",
      expiresAt: 1_800_000_000_000,
    });
    // The key that went out is the one reported back, for the transaction's externalSessionId.
    expect(session.externalSessionId).toBe(sent.idempotencyKey);
  });

  it("leaves a buy session's body exactly as it was, with no direction on it", async () => {
    // The two directions share this route, and absent means buy. The buy body is the one piece
    // of this that was already in production; it does not move.
    const { impl, calls } = stubFetch(201, {
      fundingRequestId: "funding-1",
      sessionId: "s1",
      serviceProviderWidgetUrl: "https://pay.test",
    });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    await client.createSession(SESSION_REQ);

    const sent = JSON.parse(String(calls[0]?.init?.body));
    expect(sent).not.toHaveProperty("direction");
    expect(sent).not.toHaveProperty("cryptoAmount");
    expect(Object.keys(sent).sort()).toEqual(
      [
        "country",
        "destinationCurrencyCode",
        "fiat",
        "idempotencyKey",
        "paymentMethodType",
        "serviceProvider",
        "sourceAmount",
        "walletAddress",
      ].sort(),
    );
  });

  it("marks the direction in the key so a sale cannot land on a purchase", async () => {
    const sellKey = async () => {
      const { impl, calls } = stubSequence([created]);
      await createMeldClient({
        baseUrl: "https://adapter.test",
        fetchImpl: impl,
      }).createSellSession(SELL_SESSION_REQ);
      return String(JSON.parse(String(calls[0]?.init?.body)).idempotencyKey);
    };
    const buy = stubSequence([created]);
    await createMeldClient({
      baseUrl: "https://adapter.test",
      fetchImpl: buy.impl,
      // The same corridor, the other way round: USD and DOT_ASSETHUB in both keys.
    }).createSession({ ...SESSION_REQ, paymentMethodType: "ACH" });

    const key = await sellKey();
    expect(key).toContain("sell");
    expect(key).not.toBe(JSON.parse(String(buy.calls[0]?.init?.body)).idempotencyKey);
    // Reload-stable: the same sale mints the same key.
    expect(await sellKey()).toBe(key);
  });

  it("mints a different key for a second sale in the same corridor", async () => {
    // The hazard `orderRef` exists for: a seller opens a 100 DOT sale, backs out while it is
    // still live, and starts a 50 DOT one. Without a per-order component both mint attempt-1 of
    // the same key, the adapter names the live row, and the resume hands them the first sale's
    // surface at the first sale's amount.
    const keyFor = async (over: Partial<typeof SELL_SESSION_REQ>) => {
      const { impl, calls } = stubSequence([created]);
      await createMeldClient({
        baseUrl: "https://adapter.test",
        fetchImpl: impl,
      }).createSellSession({ ...SELL_SESSION_REQ, ...over });
      return String(JSON.parse(String(calls[0]?.init?.body)).idempotencyKey);
    };

    const first = await keyFor({ sourceAmount: "100", orderRef: "order-a" });
    expect(await keyFor({ sourceAmount: "50", orderRef: "order-b" })).not.toBe(first);
    // And the ref is what does it, not the amount: the amount is solved, the order is chosen.
    expect(await keyFor({ sourceAmount: "50", orderRef: "order-a" })).toBe(first);
  });

  it("never sends the order ref, which is key material and nothing else", async () => {
    // The adapter neither needs it nor stores it, and it names one of our burners.
    const { impl, calls } = stubFetch(201, {
      fundingRequestId: "funding-sell-1",
      serviceProviderWidgetUrl: "https://sell.test",
    });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    await client.createSellSession(SELL_SESSION_REQ);

    const { idempotencyKey, ...sent } = JSON.parse(String(calls[0]?.init?.body));
    expect(sent).not.toHaveProperty("orderRef");
    // Nowhere in the body under any other name either.
    expect(JSON.stringify(sent)).not.toContain(SELL_SESSION_REQ.orderRef);
    // Only inside the key, which is where it belongs.
    expect(idempotencyKey).toContain(SELL_SESSION_REQ.orderRef);
  });

  it("does not spend a sale's attempts on the sales that came before it", async () => {
    // With a corridor-only key the sixth ever sale of this pair would walk 1…5 through rows that
    // concluded months ago and be refused. The attempt counter is a retry escape hatch for one
    // sale, not a lifetime budget for a corridor.
    const { impl, calls } = stubSequence([created]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    for (const orderRef of ["a", "b", "c", "d", "e", "f"]) {
      await client.createSellSession({ ...SELL_SESSION_REQ, orderRef });
    }

    // Every sale opened on its first attempt, and no two shared a key.
    const keys = calls.map((c) => String(JSON.parse(String(c.init?.body)).idempotencyKey));
    expect(keys).toHaveLength(6);
    expect(new Set(keys).size).toBe(6);
    for (const k of keys) expect(k.endsWith("-1")).toBe(true);
  });

  it("sends the committed crypto verbatim, at full asset precision", async () => {
    // Ten decimals is what DOT has, and the committed amount is the one figure in the whole
    // off-ramp that must survive the wire unchanged.
    const { impl, calls } = stubFetch(201, {
      fundingRequestId: "funding-sell-1",
      serviceProviderWidgetUrl: "https://sell.test",
    });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    await client.createSellSession({ ...SELL_SESSION_REQ, sourceAmount: "24.4123456789" });

    expect(JSON.parse(String(calls[0]?.init?.body)).cryptoAmount).toBe("24.4123456789");
  });

  it("refuses a resumed sale committed to a different amount", async () => {
    // Same corridor, same order ref, different size — the row is not this sale, and on a sell
    // there is no address to notice that by. A warning would let the seller send 100 believing
    // they had committed 50.
    const otherAmountFunding = {
      status: 200,
      body: {
        funding: {
          status: "session_opened",
          serviceProviderWidgetUrl: "https://sell.test/other",
          fiat: SELL_SESSION_REQ.destinationCurrencyCode,
          destinationCurrencyCode: SELL_SESSION_REQ.sourceCurrencyCode,
          cryptoAmount: "100",
        },
      },
    };
    const { impl, calls } = stubSequence([keyReused, otherAmountFunding]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    await expect(
      client.createSellSession({ ...SELL_SESSION_REQ, sourceAmount: "50" }),
    ).rejects.toThrow(/different order/i);
    expect(calls.filter((c) => c.url.endsWith("/session"))).toHaveLength(1);
  });

  it("forwards the configured redirect URL", async () => {
    const { impl, calls } = stubFetch(201, {
      fundingRequestId: "funding-sell-1",
      serviceProviderWidgetUrl: "https://sell.test",
    });
    const client = createMeldClient({
      baseUrl: "https://adapter.test",
      fetchImpl: impl,
      redirectUrl: "https://app.test/meld/return",
    });

    await client.createSellSession(SELL_SESSION_REQ);

    expect(JSON.parse(String(calls[0]?.init?.body)).redirectUrl).toBe(
      "https://app.test/meld/return",
    );
  });

  it("never walks a caller-supplied key, which is the caller's identity to own", async () => {
    const { impl, calls } = stubSequence([concluded, created]);
    const client = createMeldClient({
      baseUrl: "https://adapter.test",
      fetchImpl: impl,
      idempotencyKey: () => "caller-owns-this",
    });

    await expect(client.createSellSession(SELL_SESSION_REQ)).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]?.init?.body)).idempotencyKey).toBe("caller-owns-this");
  });

  it("returns a surface-less session when the hosted page has lapsed", async () => {
    // `REQUEST_SURFACE_EXPIRED`: the row is live, so status polling concludes it rather than a
    // second sale being opened against the same crypto.
    const surfaceExpired = {
      status: 409,
      body: {
        error: {
          tag: "Other",
          value: {
            code: "REQUEST_SURFACE_EXPIRED",
            message: "lapsed",
            fundingRequestId: "funding-lapsed",
          },
        },
      },
    };
    const { impl, calls } = stubSequence([surfaceExpired]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    const session = await client.createSellSession(SELL_SESSION_REQ);

    expect(session).toMatchObject({ fundingRequestId: "funding-lapsed", widgetUrl: "" });
    expect(calls).toHaveLength(1);
  });

  it("does NOT walk past a sale that is still being opened", async () => {
    const { impl, calls } = stubSequence([inFlight, created]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    await expect(client.createSellSession(SELL_SESSION_REQ)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("does NOT start a new attempt when the outcome is unknown", async () => {
    // The adapter could not rule out that the sale happened. Opening another could sell twice.
    const { impl, calls } = stubSequence([outcomeUnknown, created]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    await expect(client.createSellSession(SELL_SESSION_REQ)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("starts a new attempt when the adapter says the last one concluded", async () => {
    const { impl, calls } = stubSequence([concluded, concluded, created]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    const session = await client.createSellSession(SELL_SESSION_REQ);

    expect(session.fundingRequestId).toBe("funding-9");
    const keys = calls.map((c) => JSON.parse(String(c.init?.body)).idempotencyKey);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
    // Same intent throughout; only the attempt moves.
    for (const k of keys) expect(k).toContain("sell");
  });

  it("does NOT walk past a sale the seller has already been paid for", async () => {
    const { impl, calls } = stubSequence([alreadySettled, created]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    await expect(client.createSellSession(SELL_SESSION_REQ)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("re-attaches to the request the adapter named instead of minting a fresh key", async () => {
    const liveSellFunding = {
      status: 200,
      // The funding record names the fiat leg `fiat` and the crypto leg
      // `destinationCurrencyCode` whichever way the trade ran.
      body: {
        funding: {
          status: "session_opened",
          serviceProviderWidgetUrl: "https://sell.test/resume",
          fiat: SELL_SESSION_REQ.destinationCurrencyCode,
          destinationCurrencyCode: SELL_SESSION_REQ.sourceCurrencyCode,
          // A sell's row carries the committed crypto here and nothing in `sourceAmount`.
          cryptoAmount: SELL_SESSION_REQ.sourceAmount,
          sourceAmount: null,
        },
      },
    };
    const { impl, calls } = stubSequence([keyReused, liveSellFunding]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    const session = await client.createSellSession(SELL_SESSION_REQ);

    expect(session.fundingRequestId).toBe("funding-live");
    expect(session.widgetUrl).toBe("https://sell.test/resume");
    expect(calls).toHaveLength(2);
    expect(calls.filter((c) => c.url.endsWith("/session"))).toHaveLength(1);
  });

  it("refuses a resumed row that is not the sale it asked about", async () => {
    const otherPairFunding = {
      status: 200,
      // A live row selling a different asset: another order, not a moved rate.
      body: {
        funding: {
          status: "session_opened",
          serviceProviderWidgetUrl: "https://sell.test/other",
          fiat: SELL_SESSION_REQ.destinationCurrencyCode,
          destinationCurrencyCode: "USDC_ASSETHUB",
          sourceAmount: SELL_SESSION_REQ.sourceAmount,
        },
      },
    };
    const { impl, calls } = stubSequence([keyReused, otherPairFunding]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    await expect(client.createSellSession(SELL_SESSION_REQ)).rejects.toThrow(/different order/i);
    expect(calls.filter((c) => c.url.endsWith("/session"))).toHaveLength(1);
  });

  it("refuses rather than re-creating when the named request has no surface left", async () => {
    const { impl, calls } = stubSequence([keyReused, concludedFunding]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    await expect(client.createSellSession(SELL_SESSION_REQ)).rejects.toThrow(
      /do not start another/i,
    );
    expect(calls).toHaveLength(2);
  });

  it("gives up rather than walking attempts for ever", async () => {
    const { impl, calls } = stubSequence([concluded]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    await expect(client.createSellSession(SELL_SESSION_REQ)).rejects.toThrow();
    // Exactly MAX_ATTEMPTS: a weaker bound passes for a walk that gave up after one.
    expect(calls.length).toBe(5);
  });
});

describe("createMeldClient sell status", () => {
  it("reports no deposit terms while the seller is still in KYC", async () => {
    // Absent is the normal early state: the adapter discloses the terms only after KYC, and a
    // caller that treats absence as a fault would fail every sell at its first poll.
    const { impl } = stubFetch(200, {
      funding: { status: "session_opened", serviceProviderWidgetUrl: "https://sell.test/resume" },
    });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    const result = await client.getStatus("funding-sell-1");

    expect(result).not.toHaveProperty("deposit");
  });

  it("carries the deposit terms once the adapter discloses them", async () => {
    const { impl } = stubFetch(200, {
      funding: {
        status: "session_opened",
        deposit: {
          address: "14Kt4HmnCzMqUKvWcGZdLaWkLNcL4TcUSXYvKyKdbMhsvRxM",
          amount: "24.4123456789",
          currency: "DOT_ASSETHUB",
          observedAt: 1_800_000_000_000,
        },
      },
    });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    const result = await client.getStatus("funding-sell-1");

    expect(result.deposit).toEqual({
      address: "14Kt4HmnCzMqUKvWcGZdLaWkLNcL4TcUSXYvKyKdbMhsvRxM",
      // Verbatim and at full precision: sending a different amount is what makes a sell go
      // unmatched, and two decimals here would be a different amount.
      amount: "24.4123456789",
      currency: "DOT_ASSETHUB",
      observedAt: 1_800_000_000_000,
    });
    // Absent on the wire, absent here: a memo nobody sent is not an empty memo.
    expect(result.deposit).not.toHaveProperty("memo");
  });

  it("withholds a disclosure that is missing any part a seller has to act on", async () => {
    // Every one of these is worse than no disclosure: an empty address is somewhere to send real
    // funds, an empty currency reads as an asset, and a missing `observedAt` leaves a caller
    // unable to tell a fresh address from a stale one. The adapter is ours and always sends all
    // four, so anything less is a fault, and a fault means nothing was disclosed.
    const ADDRESS = "14Kt4HmnCzMqUKvWcGZdLaWkLNcL4TcUSXYvKyKdbMhsvRxM";
    const whole = {
      address: ADDRESS,
      amount: "24.4123456789",
      currency: "DOT_ASSETHUB",
      observedAt: 1_800_000_000_000,
    };
    const broken: Record<string, Record<string, unknown>> = {
      "no amount": { ...whole, amount: undefined },
      "empty address": { ...whole, address: "" },
      "empty amount": { ...whole, amount: "" },
      "no currency": { ...whole, currency: undefined },
      "empty currency": { ...whole, currency: "" },
      "no observedAt": { ...whole, observedAt: undefined },
      "unusable observedAt": { ...whole, observedAt: "recently" },
    };

    for (const [why, deposit] of Object.entries(broken)) {
      const { impl } = stubFetch(200, { funding: { status: "session_opened", deposit } });
      const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });
      expect(await client.getStatus("funding-sell-1"), why).not.toHaveProperty("deposit");
    }
  });

  it("never invents an observedAt for a disclosure that arrived without one", async () => {
    // Defaulting it to now would make an arbitrarily stale address read as seen this instant,
    // in the one field whose whole job is to let a caller judge freshness. The whole disclosure
    // goes rather than the stamp being manufactured.
    const { impl } = stubFetch(200, {
      funding: {
        status: "session_opened",
        deposit: {
          address: "14Kt4HmnCzMqUKvWcGZdLaWkLNcL4TcUSXYvKyKdbMhsvRxM",
          amount: "24.4",
          currency: "DOT_ASSETHUB",
        },
      },
    });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    const result = await client.getStatus("funding-sell-1");

    // Not a disclosure stamped with the moment this call happened to run.
    expect(result.deposit).toBeUndefined();
    expect(result.status).toBe("session_opened");
  });

  it("lets the terms go away again when the request concludes", async () => {
    // The adapter discloses them only while the request is live, so a settled poll carries none.
    // That is not an error, and not a reason to fall back on what an earlier poll said.
    const { impl } = stubFetch(200, { funding: { status: "settled" } });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    const result = await client.getStatus("funding-sell-1");

    expect(result.status).toBe("settled");
    expect(result).not.toHaveProperty("deposit");
  });
});

describe("createMeldClient cancel", () => {
  it("withdraws the pay page and returns the cancelled-at stamp", async () => {
    const { impl, calls } = stubFetch(200, {
      funding: { id: "funding-1", cancelledAt: 1_700_000_000_500 },
    });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    const result = await client.cancel("funding-1");

    expect(calls[0]?.init?.method).toBe("POST");
    expect(String(calls[0]?.url)).toBe("https://adapter.test/funding/funding-1/cancel");
    expect(result).toEqual({ outcome: "cancelled", cancelledAt: 1_700_000_000_500 });
  });

  it("reports not-cancellable when a payment is already on its way", async () => {
    const { impl } = stubFetch(409, {
      error: {
        tag: "Other",
        value: { code: "REQUEST_NOT_CANCELLABLE", message: "A payment is already on its way." },
      },
      request_id: "r1",
    });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    expect(await client.cancel("funding-1")).toEqual({ outcome: "not-cancellable" });
  });

  it("reports not-found for an unknown request", async () => {
    const { impl } = stubFetch(404, {
      error: { tag: "Other", value: { code: "NOT_FOUND" } },
      request_id: "r1",
    });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    expect(await client.cancel("nope")).toEqual({ outcome: "not-found" });
  });

  it("rethrows an unexpected adapter error rather than swallowing it", async () => {
    const { impl } = stubFetch(500, {
      error: { tag: "Other", value: { code: "BOOM" } },
      request_id: "r1",
    });
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });

    await expect(client.cancel("funding-1")).rejects.toThrow();
  });
});
