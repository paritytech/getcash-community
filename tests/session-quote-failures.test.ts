// The quote screens stop offering another try after the second failure in a row, and start
// counting again when the amount, method, region or source changes. The store keeps that count,
// and reports each failure as its rail and cause.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { MeldAssetsUnavailable } from "@getsome/core";
import { createMeldClient } from "@getsome/meld";
import { isExpected } from "../lib/telemetry/catalogue";
import { useSessionStore } from "../app/stores/session";

/** Set, the next mock world refuses to be built, which fails the quote on every rail. */
const fault = { error: null as Error | null };

const reported = vi.hoisted(() => [] as Array<{ reason: string; context?: unknown }>);
vi.mock("~~/lib/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/telemetry")>()),
  reportFailure: (kind: string, details: { reason: string; context?: unknown }) => {
    if (kind === "quote-failed")
      reported.push({ reason: details.reason, context: details.context });
  },
}));

vi.mock("../lib/coinage", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/coinage")>();
  return {
    ...original,
    createMockCoinageSession: async (
      ...args: Parameters<typeof original.createMockCoinageSession>
    ) => {
      if (fault.error !== null) throw fault.error;
      return original.createMockCoinageSession(...args);
    },
  };
});

describe("session store: quote failures in a row", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    fault.error = new Error("the rate could not be read");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts crypto quote failures and clears them on a quote that lands", async () => {
    const store = useSessionStore();
    store.setAmount("1");
    await store.fetchQuote("Bitcoin", "BTC");
    expect(store.quoteError).toBe("the rate could not be read");
    expect(store.quoteFailures).toBe(1);
    await store.fetchQuote("Bitcoin", "BTC");
    expect(store.quoteFailures).toBe(2);

    fault.error = null;
    await store.fetchQuote("Bitcoin", "BTC");
    expect(store.quoteError).toBeNull();
    expect(store.quoted).not.toBeNull();
    expect(store.quoteFailures).toBe(0);
  });

  it("a new amount or another source starts the count over", async () => {
    const store = useSessionStore();
    store.setAmount("1");
    await store.fetchQuote("Bitcoin", "BTC");
    await store.fetchQuote("Bitcoin", "BTC");
    expect(store.quoteFailures).toBe(2);

    store.setAmount("2");
    expect(store.quoteFailures).toBe(0);
    await store.fetchQuote("Bitcoin", "BTC");
    expect(store.quoteFailures).toBe(1);

    await store.fetchQuote("Ethereum", "ETH");
    expect(store.quoteFailures).toBe(1);
  });

  it("counts Meld quote failures the same way, and a region change clears them", async () => {
    const store = useSessionStore();
    store.setMethod("card");
    store.setAmount("100");
    await store.fetchMeldQuote();
    expect(store.quoteError).toBe("the rate could not be read");
    expect(store.quoteFailures).toBe(1);
    await store.fetchMeldQuote();
    expect(store.quoteFailures).toBe(2);

    store.setMeldCountry("GB");
    expect(store.quoteFailures).toBe(0);

    fault.error = null;
    await store.fetchMeldQuote();
    expect(store.quoteError).toBeNull();
    expect(store.quoteFailures).toBe(0);
  });

  it("asks for a different amount when the provider turns the amount down, without a retry", async () => {
    fault.error = await adapterRefusal({
      tag: "Other",
      value: { code: "AMOUNT_REJECTED", message: "The provider cannot take this amount." },
    });
    const store = useSessionStore();
    store.setMethod("card");
    store.setAmount("100");
    await store.fetchMeldQuote();
    expect(store.quoteAmountRejected).toBe(true);
    expect(store.quoteError).toBeNull();
    expect(store.quoteFailures).toBe(0);

    // A new amount clears it.
    store.setAmount("200");
    expect(store.quoteAmountRejected).toBe(false);
  });

  it("keeps any other refusal on the generic retry screen", async () => {
    fault.error = await adapterRefusal({
      tag: "Other",
      value: { code: "PROVIDER_REJECTED", message: "The provider declined this request." },
    });
    const store = useSessionStore();
    store.setMethod("card");
    store.setAmount("100");
    await store.fetchMeldQuote();
    expect(store.quoteAmountRejected).toBe(false);
    expect(store.quoteError).not.toBeNull();
    expect(store.quoteFailures).toBe(1);
  });
});

describe("session store: quote failures reported", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    fault.error = new Error("the rate could not be read");
    reported.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("As a developer reading Sentry, I see a crypto quote that failed as its rail, cause, chain and asset", async () => {
    // Given
    const store = useSessionStore();
    store.setAmount("1");

    // When
    await store.fetchQuote("Bitcoin", "BTC");

    // Then
    expect(reported).toEqual([
      { reason: "crypto:error", context: { chain: "Bitcoin", asset: "BTC" } },
    ]);
    expect(isExpected("quote-failed", reported[0]!.reason)).toBe(false);
  });

  it("As a developer reading Sentry, I see a refused card quote under the adapter's own code", async () => {
    // Given
    fault.error = await adapterRefusal({
      tag: "Other",
      value: { code: "PROVIDER_REJECTED", message: "The provider declined this request." },
    });
    const store = useSessionStore();
    store.setMethod("card");
    store.setAmount("100");

    // When
    await store.fetchMeldQuote();

    // Then
    expect(reported.map((r) => r.reason)).toEqual(["card:provider_rejected"]);
  });

  it("As a developer reading Sentry, I see a card quote that threw a named error under that name, not a word in its message", async () => {
    // Given: the adapter's asset table could not be read, with a message that reads like no host
    fault.error = new MeldAssetsUnavailable("The adapter is unavailable.");
    const store = useSessionStore();
    store.setMethod("card");
    store.setAmount("100");

    // When
    await store.fetchMeldQuote();

    // Then
    expect(reported.map((r) => r.reason)).toEqual(["card:meld-assets-unavailable"]);
  });

  it("As a developer reading Sentry, I get nothing when the provider asks for another amount", async () => {
    // Given
    fault.error = await adapterRefusal({
      tag: "Other",
      value: { code: "AMOUNT_REJECTED", message: "The provider cannot take this amount." },
    });
    const store = useSessionStore();
    store.setMethod("card");
    store.setAmount("100");

    // When
    await store.fetchMeldQuote();

    // Then
    expect(reported).toEqual([]);
  });

  it("As a person whose phone lost its connection, my failed quote is a warning, not our failure", async () => {
    // Given
    vi.stubGlobal("navigator", { onLine: false });
    const store = useSessionStore();
    store.setAmount("1");

    // When
    await store.fetchQuote("Bitcoin", "BTC");

    // Then
    expect(reported.map((r) => r.reason)).toEqual(["crypto:offline"]);
    expect(isExpected("quote-failed", "crypto:offline")).toBe(true);
  });
});

/** A real adapter refusal for `error`, as the Meld client throws it on a refused quote. */
async function adapterRefusal(error: unknown): Promise<Error> {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl });
  return client
    .getQuote({
      country: "DE",
      sourceCurrencyCode: "EUR",
      destinationCurrencyCode: "DOT",
      sourceAmount: "50.00",
      paymentMethodType: "CREDIT_DEBIT_CARD",
    })
    .then(
      () => new Error("expected a refusal"),
      (e: unknown) => e as Error,
    );
}
