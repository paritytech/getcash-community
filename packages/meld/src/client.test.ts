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
    expect(calls.length).toBeLessThanOrEqual(5);
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
