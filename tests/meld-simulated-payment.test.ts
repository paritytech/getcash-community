// The demo's Skip button plays a whole fiat payment, rather than dropping a deposit mid-journey.
// Without this the timeline opens halfway through, with steps that never happened behind it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useSessionStore } from "../app/stores/session";

describe("simulateMeldPayment", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("walks the payment from the widget to settled, in order", async () => {
    const store = useSessionStore();
    store.setMethod("card");
    store.setAmount("100");
    await store.fetchMeldQuote();

    store.simulateMeldPayment();
    // The buyer has left the widget: the journey takes over from the iframe at once, on "Payment".
    expect(store.meldSubmitted).toBe(true);
    expect(store.meldStage).not.toBe("complete");
    expect(store.journeyDone).toBe(1);

    // The provider sees the transaction.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(store.meldStage).toBe("receiving");
    expect(store.meldHandedOff).toBe(true);
    expect(store.journeyDone).toBe(2);

    // It approves it.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(store.meldStage).toBe("complete");
    expect(store.journeyDone).toBe(3);

    // The conversion runs.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(store.journeyDone).toBe(4);
  });

  it("walks one step at a time, never two at once", async () => {
    // The whole point of Skip is watching the five steps land; a jump from Payment to Conversion
    // is the bug this replaced.
    const store = useSessionStore();
    store.setMethod("card");
    store.setAmount("100");
    await store.fetchMeldQuote();

    store.simulateMeldPayment();
    const seen: number[] = [store.journeyDone];
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(2_500);
      seen.push(store.journeyDone);
    }

    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it("does nothing on the crypto rail, which has no fiat payment to play", async () => {
    const store = useSessionStore();
    store.setMethod("crypto");

    store.simulateMeldPayment();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(store.meldStage).toBeNull();
    expect(store.meldSubmitted).toBe(false);
  });

  it("drops its timers when the world goes, so a left journey cannot settle behind the buyer", async () => {
    const store = useSessionStore();
    store.setMethod("card");
    store.setAmount("100");
    await store.fetchMeldQuote();

    store.simulateMeldPayment();
    store.reset();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(store.meldStage).toBeNull();
    // The demo's floor goes with the world it belonged to.
    expect(store.journeyDone).toBe(1);
  });
});
