// What the provider destinations offer for an amount: how a row reads an offer, and how the store
// quotes once per amount and keeps it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
  WITHDRAW_NETWORKS,
  withdrawDestination,
  withdrawNetwork,
} from "../app/withdraw/destinations";
import { networkRow, rowState, type WithdrawOffer } from "../app/withdraw/offers";

vi.mock("../lib/withdraw-live", () => ({ quoteWithdrawOffers: vi.fn() }));

import { quoteWithdrawOffers } from "../lib/withdraw-live";
import { FLOORS_STALE_MS } from "../app/stores/offers";
import { useWithdrawOffersStore } from "../app/stores/withdraw-offers";

const quote = vi.mocked(quoteWithdrawOffers);

const assetHub = withdrawDestination("dot-assethub")!;
const bitcoin = withdrawNetwork("Bitcoin")!;
const btc = withdrawDestination("btc")!;
const AVAILABLE: WithdrawOffer = {
  state: "available",
  egress: 123_456n,
  formatted: "0.001234 BTC",
  etaSeconds: 900,
};
const TOO_SMALL: WithdrawOffer = { state: "too-small", minimumCash: 12_500_000n }; // 12.5 CASH

/** Every provider destination answered the same way. */
function everyOffer(offer: WithdrawOffer, sellable: bigint | null = 40_000_000_000n) {
  const offers = new Map<string, WithdrawOffer>();
  for (const network of WITHDRAW_NETWORKS) {
    for (const destination of network.destinations) {
      if (destination.rail !== "direct") offers.set(destination.id, offer);
    }
  }
  return { sellable, offers };
}

describe("a row against its offer", () => {
  it("always lets Asset Hub through: the direct rail has no provider", () => {
    expect(rowState(assetHub, { state: "checking" })).toEqual({ pickable: true });
    expect(rowState(assetHub, { state: "unavailable", reason: "x" }).pickable).toBe(true);
  });

  it("says why a provider destination cannot be picked, and nothing when it can", () => {
    expect(rowState(btc, { state: "rail-off" })).toEqual({
      pickable: false,
      subtitle: "Not available yet",
    });
    expect(rowState(btc, { state: "checking" }).subtitle).toBe("Checking…");
    expect(rowState(btc, { state: "unavailable", reason: "down" }).subtitle).toBe(
      "Not available right now",
    );
    expect(rowState(btc, TOO_SMALL)).toEqual({ pickable: false, subtitle: "Minimum is $13 CASH" });
    expect(rowState(btc, AVAILABLE)).toEqual({ pickable: true });
  });

  it("reads a network off its tokens", () => {
    expect(networkRow([{ pickable: false, subtitle: "a" }, { pickable: true }])).toEqual({
      pickable: true,
    });
    expect(
      networkRow([
        { pickable: false, subtitle: "a" },
        { pickable: false, subtitle: "b" },
      ]),
    ).toEqual({ pickable: false, subtitle: "a" });
    expect(networkRow([])).toEqual({ pickable: false });
  });
});

describe("the withdraw offers store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    quote.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("quotes once per amount, reuses a fresh answer, asks again when stale or unanswered", async () => {
    quote
      .mockResolvedValueOnce(everyOffer({ state: "unavailable", reason: "down" }, null))
      .mockResolvedValue(everyOffer(AVAILABLE));
    const store = useWithdrawOffersStore();
    store.railOn = true;
    expect(store.rowFor(btc).subtitle).toBe("Checking…");

    await store.learn(50_000_000n);
    expect(quote).toHaveBeenCalledWith(50_000_000n, expect.any(Array));
    expect(store.rowFor(btc).subtitle).toBe("Not available right now");
    expect(store.networkRowFor(bitcoin).pickable).toBe(false);

    await store.learn(50_000_000n); // no answer stands for nothing: asked again
    expect(quote).toHaveBeenCalledTimes(2);
    expect(store.rowFor(btc)).toEqual({ pickable: true });
    expect(store.offerFor(btc)).toEqual(AVAILABLE);
    expect(store.sellable).toBe(40_000_000_000n);

    await store.learn(50_000_000n);
    expect(quote).toHaveBeenCalledTimes(2); // fresh: reused
    await store.learn(60_000_000n);
    expect(quote).toHaveBeenCalledTimes(3); // another amount: asked for it
    vi.advanceTimersByTime(FLOORS_STALE_MS);
    await store.learn(60_000_000n);
    expect(quote).toHaveBeenCalledTimes(4); // stale: asked again
  });

  it("drops an answer for an amount that moved on while it was in flight", async () => {
    let release: (value: ReturnType<typeof everyOffer>) => void = () => {};
    quote
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
      .mockResolvedValueOnce(everyOffer(TOO_SMALL));
    const store = useWithdrawOffersStore();
    store.railOn = true;
    const first = store.learn(50_000_000n);
    const second = store.learn(5_000_000n);
    // A third look at the new amount joins its load rather than starting another: two quotes
    // in all, asserted below.
    const third = store.learn(5_000_000n);
    release(everyOffer(AVAILABLE));
    await third;
    await Promise.all([first, second]);
    expect(quote).toHaveBeenCalledTimes(2);
    expect(store.amount).toBe(5_000_000n);
    expect(store.offerFor(btc)).toEqual(TOO_SMALL);
  });

  it("keeps the current rows on screen while a stale answer for the same amount is refreshed", async () => {
    let release: (value: ReturnType<typeof everyOffer>) => void = () => {};
    quote
      .mockResolvedValueOnce(everyOffer(AVAILABLE))
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const store = useWithdrawOffersStore();
    store.railOn = true;
    await store.learn(50_000_000n);
    vi.advanceTimersByTime(FLOORS_STALE_MS);
    const refresh = store.learn(50_000_000n);
    expect(store.offerFor(btc)).toEqual(AVAILABLE); // the old answer stands meanwhile
    release(everyOffer(TOO_SMALL));
    await refresh;
    expect(store.offerFor(btc)).toEqual(TOO_SMALL);
  });

  it("asks nothing while the rail is off, and says so on every provider row", async () => {
    const store = useWithdrawOffersStore();
    store.railOn = false;
    await store.learn(50_000_000n);
    expect(quote).not.toHaveBeenCalled();
    expect(store.rowFor(btc).subtitle).toBe("Not available yet");
    expect(store.rowFor(assetHub)).toEqual({ pickable: true });
  });
});
