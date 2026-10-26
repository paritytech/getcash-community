// The quote screens stop offering another try after the second failure in a row, and start
// counting again when the amount, method, region or source changes. The store keeps that count.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useSessionStore } from "../app/stores/session";

/** Set, the next mock world refuses to be built, which fails the quote on every rail. */
const fault = { error: null as Error | null };

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
});
