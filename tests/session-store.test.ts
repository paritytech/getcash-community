// Store-level smoke: the browser (mock-world) quote path end to end, the exact path a
// plain localhost:3000 visitor exercises.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { FakeRail } from "@getsome/testing";
import { useRequestsStore } from "../app/stores/requests";
import { useSessionStore } from "../app/stores/session";
import { refundStorageKey } from "../lib/coinage";

describe("session store: mock-world quote", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("quotes 1 CASH from the Bitcoin pill in the plain-browser world", async () => {
    const store = useSessionStore();
    store.setAmount("1");
    expect(store.amountBase).toBe(1_000_000n);
    await store.fetchQuote("Bitcoin", "BTC");
    expect(store.quoteError).toBeNull();
    expect(store.quoted).not.toBeNull();
    expect(store.loading).toBe(false);
  });

  // The funded gate polls in seconds; this test runs on real time.
  it(
    "start() enters the flow and the mock deposit + consent complete it",
    { timeout: 30_000 },
    async () => {
      const store = useSessionStore();
      const requests = useRequestsStore();
      store.setAmount("1");
      await store.fetchQuote("Bitcoin", "BTC");
      await store.start();
      expect(requests.phase).toBe("awaiting-deposit");
      expect(requests.foregroundProgress?.snapshot).toMatchObject({
        latestRouteStatus: "waiting",
        stageTimestamps: {},
      });
      // The channel refunds to the request's own Bitcoin key, never to a typed address.
      const world = store.mock!;
      const slot = refundStorageKey("btc", 1);
      expect(store.revealRefundKey()?.chain).toBe("Bitcoin");
      const rail = world.rail as FakeRail;
      expect(rail.stats.lastChannelArgs?.refundAddress).toBe(world.refundAddress);
      expect(await world.storage.read(slot)).not.toBeNull();
      store.simulateDeposit();
      // funded-gate poll -> settle -> consent
      await new Promise((r) => setTimeout(r, 50));
      const waitFor = async (pred: () => boolean, ms: number) => {
        const until = Date.now() + ms;
        while (!pred() && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
      };
      await waitFor(() => requests.phase === "working", 15_000);
      // The deposit landed: the refund key is forgotten, in memory and in storage.
      expect(store.revealRefundKey()).toBeNull();
      expect(await world.storage.read(slot)).toBeNull();
      store.approveClaim();
      await waitFor(() => requests.phase === "done", 10_000);
      expect(requests.phase).toBe("done");
      expect(requests.foregroundProgress?.snapshot).toMatchObject({
        confirmedStageKey: "cash-top-up",
        settledAt: expect.any(Number),
      });
    },
  );
});

describe("session store: Meld (card / bank) in the mock world", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("quotes a card purchase through the offline fake Meld client, in the region's fiat", async () => {
    const store = useSessionStore();
    store.setMethod("card");
    store.setAmount("100");
    await store.fetchMeldQuote();
    expect(store.quoteError).toBeNull();
    expect(store.meldMethodUnavailable).toBe(false);
    expect(store.quoted).toMatchObject({ symbol: "USD", sourceAsset: null, sourceChain: null });
    expect(Number(store.quoted?.send)).toBeGreaterThan(0);
    expect(store.loading).toBe(false);
  });

  it("marks bank unavailable in a region with no bank rail instead of failing the quote", async () => {
    const store = useSessionStore();
    store.setMethod("bank");
    store.setMeldCountry("US");
    store.setAmount("100");
    await store.fetchMeldQuote();
    expect(store.meldMethodUnavailable).toBe(true);
    expect(store.quoteError).toBeNull();
    expect(store.quoted).toBeNull();
  });

  it("start() reaches awaiting-deposit with the provider's pay page and the Meld progress profile", async () => {
    const store = useSessionStore();
    const requests = useRequestsStore();
    store.setMethod("card");
    store.setAmount("100");
    await store.fetchMeldQuote();
    await store.start();
    expect(requests.phase).toBe("awaiting-deposit");
    expect(store.meldPayUrl).toMatch(/^https:\/\//);
    expect(requests.foregroundProgress?.snapshot.profile.id).toBe("meld");
    expect(requests.foregroundProgress?.snapshot.preDetectionEstimateText).toBe(
      "≈ minutes after you pay",
    );
  });

  it("hides the pay widget once the buyer has submitted, so a re-open cannot re-charge", async () => {
    const store = useSessionStore();
    const requests = useRequestsStore();
    store.setMethod("card");
    store.setAmount("100");
    await store.fetchMeldQuote();
    await store.start();
    // The buyer finished the provider widget (the completion redirect fired).
    await store.markMeldSubmitted();
    expect(requests.meldSubmitted).toBe(true);
    // meldPayUrl null keeps the widget from rendering again.
    expect(store.meldPayUrl).toBeNull();
  });

  it("re-opens a top-up from the list with no host to rebuild a hosted world from", async () => {
    const store = useSessionStore();
    const requests = useRequestsStore();
    store.setMethod("card");
    store.setAmount("100");
    await store.fetchMeldQuote();
    await store.start();
    const record = requests.foregroundRecord;
    if (record === null) throw new Error("the started request has no record");
    const { ref } = record;
    const send = store.quoted?.send;

    // Leaving the screen drops the world, as walking back to the list does. The record stays.
    store.reset();
    expect(requests.foregroundRecord).toBeNull();

    // Tapping the row. The browser has no host, and the top-up opens all the same.
    expect(await store.openRequest(ref)).toBe(true);
    expect(requests.foregroundRecord?.ref).toEqual(ref);
    expect(requests.phase).toBe("awaiting-deposit");
    // The quote it was opened with, read back off the record rather than quoted again.
    expect(store.quoted).toMatchObject({ send, symbol: "USD" });
    // A world the screens can act on: a cancel has a session to clear, and the resume is over.
    expect(store.cancelReady).toBe(true);
    expect(store.resuming).toBe(false);
  });

  it("cancels a card top-up and tears the request down", async () => {
    const store = useSessionStore();
    const requests = useRequestsStore();
    store.setMethod("card");
    store.setAmount("100");
    await store.fetchMeldQuote();
    await store.start();
    expect(requests.phase).toBe("awaiting-deposit");

    expect(await store.cancelTopUp()).toBe(true);
    expect(store.cancelNotice).toBeNull();
    expect(requests.phase).toBeNull();
  });

  // Discovery is unconfigured in the mock world (no VITE_MELD_BASE_URL), so the loader is a no-op.
  it("loadSupportedCorridors leaves corridorByCountry null when discovery is unconfigured", async () => {
    const store = useSessionStore();
    await store.loadSupportedCorridors();
    expect(store.corridorByCountry).toBeNull();
  });
});

describe("session store: supported corridors loader against a live adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("fills corridorByCountry from the bulk endpoint", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_MELD_BASE_URL", "https://adapter.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              corridors: [
                {
                  country: "US",
                  fiat: "USD",
                  methods: [
                    {
                      paymentMethodType: "CREDIT_DEBIT_CARD",
                      category: "card",
                      min: "10",
                      max: "5000",
                      currency: "USD",
                      providers: [],
                    },
                  ],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    // Re-import both pinia and the store after the reset so they share one module instance.
    const { createPinia: freshPinia, setActivePinia: setFresh } = await import("pinia");
    setFresh(freshPinia());
    const { useSessionStore: freshStore } = await import("../app/stores/session");
    const store = freshStore();
    await store.loadSupportedCorridors();
    expect(store.corridorByCountry?.get("US")?.methods[0]?.category).toBe("card");
  });

  it("keeps corridorByCountry null on a cold (empty) bulk read, so the dropdown never bricks", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_MELD_BASE_URL", "https://adapter.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ corridors: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const { createPinia: freshPinia, setActivePinia: setFresh } = await import("pinia");
    setFresh(freshPinia());
    const { useSessionStore: freshStore } = await import("../app/stores/session");
    const store = freshStore();
    await store.loadSupportedCorridors();
    // Empty catalog must not be adopted (else every country greys out).
    expect(store.corridorByCountry).toBeNull();
  });
});
