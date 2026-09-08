// Store-level smoke: the browser (mock-world) quote path end to end, the exact path a
// plain localhost:3000 visitor exercises.

import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { FakeRail } from "@getsome/testing";
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
      store.setAmount("1");
      await store.fetchQuote("Bitcoin", "BTC");
      await store.start();
      expect(store.phase).toBe("awaiting-deposit");
      expect(store.foregroundProgress?.snapshot).toMatchObject({
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
      await waitFor(() => store.phase === "working", 15_000);
      // The deposit landed: the refund key is forgotten, in memory and in storage.
      expect(store.revealRefundKey()).toBeNull();
      expect(await world.storage.read(slot)).toBeNull();
      store.approveClaim();
      await waitFor(() => store.phase === "done", 10_000);
      expect(store.phase).toBe("done");
      expect(store.foregroundProgress?.snapshot).toMatchObject({
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
    store.setMethod("card");
    store.setAmount("100");
    await store.fetchMeldQuote();
    await store.start();
    expect(store.phase).toBe("awaiting-deposit");
    expect(store.meldPayUrl).toMatch(/^https:\/\//);
    expect(store.foregroundProgress?.snapshot.profile.id).toBe("meld");
    expect(store.foregroundProgress?.snapshot.preDetectionEstimateText).toBe(
      "≈ minutes after you pay",
    );
  });

  it("hides the pay widget once the buyer has submitted, so a re-open cannot re-charge", async () => {
    const store = useSessionStore();
    store.setMethod("card");
    store.setAmount("100");
    await store.fetchMeldQuote();
    await store.start("");
    // The buyer finished the provider widget (the completion redirect fired).
    await store.markMeldSubmitted();
    expect(store.meldSubmitted).toBe(true);
    // meldPayUrl null keeps the widget from rendering again.
    expect(store.meldPayUrl).toBeNull();
  });
});
