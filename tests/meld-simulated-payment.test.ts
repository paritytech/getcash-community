// The demo's Skip button plays a whole fiat payment, rather than dropping a deposit mid-journey.
// Without this the timeline opens halfway through, with steps that never happened behind it. The
// play is the status poll's own observations, so the record counts the steps exactly as a real
// payment's would be counted.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useRequestsStore } from "../app/stores/requests";
import { useSessionStore } from "../app/stores/session";

/** A card request on screen, awaiting its payment. Started on real time: the world it builds
 *  waits on chain work of its own. */
async function cardOnScreen() {
  const store = useSessionStore();
  store.setMethod("card");
  store.setAmount("100");
  await store.fetchMeldQuote();
  await store.start();
  return store;
}

describe("simulateMeldPayment", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.useRealTimers());

  it("walks the payment from the widget to the deposit, in order", async () => {
    const store = await cardOnScreen();
    const requests = useRequestsStore();
    vi.useFakeTimers();

    store.simulateMeldPayment();
    await vi.advanceTimersByTimeAsync(0);
    // The buyer has left the widget: the journey takes over from the iframe at once, with only
    // "Started" behind it.
    expect(requests.meldSubmitted).toBe(true);
    expect(requests.meldHandedOff).toBe(true);
    expect(requests.meldStage).toBe("receiving");
    expect(requests.journeyDone).toBe(1);

    // The provider sees the transaction: the payment lands on the record.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(requests.journeyDone).toBe(2);

    // It approves it: the rail's leg is delivered.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(requests.meldStage).toBe("complete");

    // The deposit that pays for the conversion is dropped on the burner; the real pipeline takes
    // the journey the rest of the way.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(requests.depositSkipped).toBe(true);
  });

  it("walks one step at a time, never two at once", async () => {
    // The whole point of Skip is watching the payment land rung by rung; a jump from the widget
    // straight to the conversion is the bug this replaced.
    const store = await cardOnScreen();
    const requests = useRequestsStore();
    vi.useFakeTimers();

    store.simulateMeldPayment();
    await vi.advanceTimersByTimeAsync(0);
    const rung = () => `${requests.meldStage ?? "none"}/${String(requests.journeyDone)}`;
    const seen = [rung()];
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(2_500);
      seen.push(rung());
    }

    // "Approved" waits for the deposit on the burner at finality, so the provider's own delivery
    // leaves the count on the payment step.
    expect(seen).toEqual(["receiving/1", "receiving/2", "complete/2", "complete/2"]);
  });

  it("does nothing on the crypto rail, which has no fiat payment to play", async () => {
    const store = useSessionStore();
    const requests = useRequestsStore();
    store.setMethod("crypto");
    vi.useFakeTimers();

    store.simulateMeldPayment();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(requests.meldStage).toBeNull();
    expect(requests.meldSubmitted).toBe(false);
  });

  it("drops its timers when the world goes, so a left journey cannot settle behind the buyer", async () => {
    const store = await cardOnScreen();
    const requests = useRequestsStore();
    vi.useFakeTimers();

    store.simulateMeldPayment();
    store.reset();
    await vi.advanceTimersByTimeAsync(10_000);

    // The request left the screen with the world it belonged to; nothing was played behind it.
    expect(requests.meldStage).toBeNull();
    expect(requests.journeyDone).toBe(1);
  });
});
