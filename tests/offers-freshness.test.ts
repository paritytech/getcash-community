// How the offers store keeps the floors fresh: a good answer stands for a while, no answer is
// asked again with a growing delay while a picker watches, and the page coming back into view
// takes another look.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { SourceId } from "@getsome/core";
import type { SourceFloorResult } from "@getsome/chainflip";

vi.mock("../lib/source-floors", () => ({ learnSourceFloors: vi.fn() }));

import { learnSourceFloors } from "../lib/source-floors";
import { FLOORS_RETRY_DELAYS_MS, FLOORS_STALE_MS, useOffersStore } from "../app/stores/offers";

const learn = vi.mocked(learnSourceFloors);
const DOT = 10_000_000_000n;

const GOOD = new Map<SourceId, SourceFloorResult>([
  [
    "eth",
    {
      kind: "floor",
      floor: {
        sourceId: "eth",
        minimumBaseUnits: 10n ** 16n,
        minimumEgressBaseUnits: 25n * DOT,
        etaSeconds: 600,
      },
    },
  ],
]);
const NOTHING = new Map<SourceId, SourceFloorResult>([
  ["eth", { kind: "unavailable", reason: "maintenance" }],
  ["btc", { kind: "unavailable", reason: "maintenance" }],
]);

/** A document whose visibility the test flips. */
function fakeDocument() {
  const listeners = new Set<() => void>();
  return {
    visibilityState: "visible" as string,
    addEventListener: (_type: "visibilitychange", listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: "visibilitychange", listener: () => void) => {
      listeners.delete(listener);
    },
    show() {
      this.visibilityState = "visible";
      for (const listener of listeners) listener();
    },
    hide() {
      this.visibilityState = "hidden";
      for (const listener of listeners) listener();
    },
    get listening() {
      return listeners.size;
    },
  };
}

/** Lets the mocked learn resolve and the store's then run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("offers store: keeping the floors fresh", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    learn.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("asks again with a growing delay while Chainflip answers for nothing and someone watches", async () => {
    learn.mockResolvedValueOnce(NOTHING).mockResolvedValueOnce(NOTHING).mockResolvedValue(GOOD);
    const offers = useOffersStore();
    const doc = fakeDocument();
    const release = offers.keepFresh(doc);
    await settle();
    expect(learn).toHaveBeenCalledTimes(1);
    expect(offers.paused).toBe(true);

    await vi.advanceTimersByTimeAsync(FLOORS_RETRY_DELAYS_MS[0]! - 1);
    expect(learn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(learn).toHaveBeenCalledTimes(2); // still nothing: the next wait is longer

    await vi.advanceTimersByTimeAsync(FLOORS_RETRY_DELAYS_MS[0]!);
    expect(learn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(FLOORS_RETRY_DELAYS_MS[1]! - FLOORS_RETRY_DELAYS_MS[0]!);
    expect(learn).toHaveBeenCalledTimes(3);
    expect(offers.paused).toBe(false); // an answer: the asking stops

    await vi.advanceTimersByTimeAsync(FLOORS_RETRY_DELAYS_MS[4]! * 2);
    expect(learn).toHaveBeenCalledTimes(3);
    release();
  });

  it("stops asking once nobody watches", async () => {
    learn.mockResolvedValue(NOTHING);
    const offers = useOffersStore();
    const doc = fakeDocument();
    const release = offers.keepFresh(doc);
    await settle();
    expect(learn).toHaveBeenCalledTimes(1);
    release();
    expect(doc.listening).toBe(0);
    await vi.advanceTimersByTimeAsync(FLOORS_RETRY_DELAYS_MS[4]! * 2);
    expect(learn).toHaveBeenCalledTimes(1);
  });

  it("reuses a good answer until it goes stale, then asks on the next look", async () => {
    learn.mockResolvedValue(GOOD);
    const offers = useOffersStore();
    const doc = fakeDocument();
    offers.keepFresh(doc)();
    await settle();
    expect(learn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(FLOORS_STALE_MS - 1);
    offers.keepFresh(doc)();
    await settle();
    expect(learn).toHaveBeenCalledTimes(1); // fresh: reused

    await vi.advanceTimersByTimeAsync(1);
    offers.keepFresh(doc)();
    await settle();
    expect(learn).toHaveBeenCalledTimes(2); // stale: asked again
    expect(offers.floors).toBe(GOOD); // and the old answer stayed on screen meanwhile
  });

  it("looks again when the page comes back into view, and waits while it is hidden", async () => {
    learn.mockResolvedValue(NOTHING);
    const offers = useOffersStore();
    const doc = fakeDocument();
    const release = offers.keepFresh(doc);
    await settle();
    expect(learn).toHaveBeenCalledTimes(1);

    doc.hide();
    await vi.advanceTimersByTimeAsync(FLOORS_RETRY_DELAYS_MS[4]! * 2);
    expect(learn).toHaveBeenCalledTimes(1); // hidden: no asking

    doc.show();
    await settle();
    expect(learn).toHaveBeenCalledTimes(2); // visible again and still nothing: asked at once
    release();
  });

  it("asks nothing while the build's rail is off", async () => {
    learn.mockResolvedValue(GOOD);
    const offers = useOffersStore();
    offers.railEnabled = false;
    const release = offers.keepFresh(fakeDocument());
    await settle();
    expect(learn).not.toHaveBeenCalled();
    release();
  });
});
