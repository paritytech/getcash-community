// The floor under a provider withdrawal: how a row reads against it, and how the store learns
// and keeps it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
  WITHDRAW_NETWORKS,
  withdrawDestination,
  withdrawNetwork,
} from "../app/withdraw/destinations";
import { destinationState, networkState, type WithdrawFloor } from "../app/withdraw/floor";

vi.mock("../lib/withdraw-live", () => ({ learnWithdrawFloor: vi.fn() }));

import { learnWithdrawFloor } from "../lib/withdraw-live";
import { FLOORS_STALE_MS } from "../app/stores/offers";
import { useWithdrawFloorStore } from "../app/stores/withdraw-floor";

const learn = vi.mocked(learnWithdrawFloor);

const assetHub = withdrawDestination("dot-assethub")!;
const bitcoin = withdrawNetwork("Bitcoin")!;
const btc = withdrawDestination("btc")!;
const KNOWN: WithdrawFloor = { state: "known", minimumCash: 12_500_000n }; // 12.5 CASH

describe("a row against the floor", () => {
  it("always lets Asset Hub through: the direct rail has no floor", () => {
    expect(destinationState(assetHub, 1n, { state: "checking" }, false)).toEqual({
      pickable: true,
    });
    expect(destinationState(assetHub, null, { state: "unknown", reason: "x" }, true).pickable).toBe(
      true,
    );
  });

  it("greys a Chainflip row while the rail is off, whatever the floor says", () => {
    expect(destinationState(btc, 100_000_000n, KNOWN, false)).toEqual({
      pickable: false,
      subtitle: "Not available yet",
    });
  });

  it("waits on the floor rather than guessing, and says when it could not be learned", () => {
    expect(destinationState(btc, 100_000_000n, { state: "checking" }, true).subtitle).toBe(
      "Checking…",
    );
    expect(destinationState(btc, 100_000_000n, { state: "unknown", reason: "down" }, true)).toEqual(
      {
        pickable: false,
        subtitle: "Not available right now",
      },
    );
  });

  it("greys an amount under the floor with the minimum in whole CASH, rounded up", () => {
    expect(destinationState(btc, 12_000_000n, KNOWN, true)).toEqual({
      pickable: false,
      subtitle: "Minimum is 13 $CASH",
    });
    expect(destinationState(btc, 12_500_000n, KNOWN, true)).toEqual({ pickable: true });
    expect(destinationState(btc, null, KNOWN, true)).toEqual({ pickable: true });
  });

  it("reads a network off its tokens", () => {
    expect(networkState(bitcoin, 5_000_000n, KNOWN, true).subtitle).toMatch(/Minimum is/);
    expect(networkState(bitcoin, 50_000_000n, KNOWN, true)).toEqual({ pickable: true });
    expect(networkState(WITHDRAW_NETWORKS[0]!, 1n, { state: "checking" }, false)).toEqual({
      pickable: true,
    });
  });
});

describe("the floor store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    learn.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("learns once while fresh, asks again when stale or when the last answer was no answer", async () => {
    learn.mockResolvedValueOnce({ state: "unknown", reason: "down" }).mockResolvedValue(KNOWN);
    const store = useWithdrawFloorStore();
    store.railOn = true;
    await store.learn();
    expect(store.floor).toEqual({ state: "unknown", reason: "down" });
    await store.learn(); // no answer stands for nothing: asked again
    expect(store.floor).toEqual(KNOWN);
    expect(learn).toHaveBeenCalledTimes(2);

    await store.learn();
    expect(learn).toHaveBeenCalledTimes(2); // fresh: reused
    vi.advanceTimersByTime(FLOORS_STALE_MS);
    await store.learn();
    expect(learn).toHaveBeenCalledTimes(3); // stale: asked again
  });

  it("asks nothing while the rail is off", async () => {
    const store = useWithdrawFloorStore();
    store.railOn = false;
    await store.learn();
    expect(learn).not.toHaveBeenCalled();
    expect(store.stateOf(btc, 100_000_000n).subtitle).toBe("Not available yet");
  });
});
