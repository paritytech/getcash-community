// What the provider destinations offer for an amount: how a row reads an offer, and how the store
// quotes once per amount and keeps it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
  WITHDRAW_NETWORKS,
  withdrawDestination,
  withdrawNetwork,
} from "../app/withdraw/destinations";
import type { ConversionRoute } from "@getsome/funding";
import { networkRow, rowState, sameSale, type WithdrawOffer } from "../app/withdraw/offers";

vi.mock("../lib/withdraw-live", () => ({ quoteWithdrawOffers: vi.fn() }));

import { quoteWithdrawOffers } from "../lib/withdraw-live";
import { FLOORS_STALE_MS } from "../app/stores/offers";
import { useWithdrawOffersStore } from "../app/stores/withdraw-offers";

const quote = vi.mocked(quoteWithdrawOffers);

/** CASH this app's own PSM withdrawals have spoken for. */
const RESERVED = 20_000_000n;
const assetHub = withdrawDestination("dot-assethub")!;
const bitcoin = withdrawNetwork("Bitcoin")!;
const btc = withdrawDestination("btc")!;
const AVAILABLE: WithdrawOffer = {
  state: "available",
  sale: { tier: "pool" },
  sellable: 40_000_000_000n,
  egress: 123_456n,
  formatted: "0.001234 BTC",
  etaSeconds: 900,
};
const TOO_SMALL: WithdrawOffer = { state: "too-small", minimumCash: 12_500_000n }; // 12.5 CASH

/** Every provider destination answered the same way. */
function everyOffer(offer: WithdrawOffer): ReadonlyMap<string, WithdrawOffer> {
  const offers = new Map<string, WithdrawOffer>();
  for (const network of WITHDRAW_NETWORKS) {
    for (const destination of network.destinations) {
      if (destination.rail !== "direct") offers.set(destination.id, offer);
    }
  }
  return offers;
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
    // Never drawn as a row: the picker shows a skeleton row in its place.
    expect(rowState(btc, { state: "checking" })).toEqual({ pickable: false });
    expect(rowState(btc, { state: "unavailable", reason: "down" }).subtitle).toBe(
      "Not available right now",
    );
    expect(rowState(btc, TOO_SMALL)).toEqual({
      pickable: false,
      subtitle: "Minimum for this token is $13 CASH",
    });
    expect(rowState(btc, TOO_SMALL, "network").subtitle).toBe(
      "Minimum for this network is $13 CASH",
    );
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

describe("whether the sale at confirm is the one the summary showed", () => {
  const PSM: ConversionRoute = { tier: "psm", external: "USDT", feeRate: 5_000 };
  it.each<[string, ConversionRoute, ConversionRoute, boolean]>([
    ["the same PSM sale", PSM, { ...PSM }, true],
    ["the PSM at another fee rate", PSM, { ...PSM, feeRate: 6_000 }, false],
    ["the PSM against the pool", PSM, { tier: "pool" }, false],
    ["the pool for the native", { tier: "pool" }, { tier: "pool" }, true],
    ["the pool fed through a stable", { tier: "pool" }, { tier: "pool", external: "USDT" }, false],
    ["dotUSD", { tier: "dotusd" }, { tier: "dotusd" }, true],
  ])("%s", (_, shown, fresh, same) => {
    expect(sameSale(shown, fresh)).toBe(same);
    expect(sameSale(fresh, shown)).toBe(same);
  });
});

describe("the withdraw offers store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    quote.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("quotes once per amount and reserved room, reuses a fresh answer, asks again when stale or unanswered", async () => {
    quote
      .mockResolvedValueOnce(everyOffer({ state: "unavailable", reason: "down" }))
      .mockResolvedValue(everyOffer(AVAILABLE));
    const store = useWithdrawOffersStore();
    store.railOn = true;
    // Nothing quoted yet: the pickers wait, except one of Asset Hub's own tokens.
    expect(store.rowFor(btc)).toEqual({ pickable: false });
    expect(store.awaitingNetworks).toBe(true);
    expect(store.awaitingTokens(bitcoin)).toBe(true);
    expect(store.awaitingTokens(withdrawNetwork("Polkadot")!)).toBe(false);

    await store.learn(50_000_000n, RESERVED);
    expect(quote).toHaveBeenCalledWith(50_000_000n, expect.any(Array), RESERVED);
    expect(store.awaitingNetworks).toBe(false);
    expect(store.awaitingTokens(bitcoin)).toBe(false);
    expect(store.rowFor(btc).subtitle).toBe("Not available right now");
    expect(store.networkRowFor(bitcoin).pickable).toBe(false);

    await store.learn(50_000_000n, RESERVED); // no answer stands for nothing: asked again
    expect(quote).toHaveBeenCalledTimes(2);
    expect(store.rowFor(btc)).toEqual({ pickable: true });
    expect(store.offerFor(btc)).toEqual(AVAILABLE);

    await store.learn(50_000_000n, RESERVED);
    expect(quote).toHaveBeenCalledTimes(2); // fresh: reused
    await store.learn(50_000_000n, RESERVED + 10_000_000n);
    expect(quote).toHaveBeenCalledTimes(3); // a withdrawal started meanwhile: asked again
    expect(quote).toHaveBeenLastCalledWith(50_000_000n, expect.any(Array), RESERVED + 10_000_000n);
    await store.learn(60_000_000n, RESERVED);
    expect(quote).toHaveBeenCalledTimes(4); // another amount: asked for it
    vi.advanceTimersByTime(FLOORS_STALE_MS);
    await store.learn(60_000_000n, RESERVED);
    expect(quote).toHaveBeenCalledTimes(5); // stale: asked again
  });

  it("drops an answer for an amount that moved on while it was in flight", async () => {
    let release: (value: ReturnType<typeof everyOffer>) => void = () => {};
    quote
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
      .mockResolvedValueOnce(everyOffer(TOO_SMALL));
    const store = useWithdrawOffersStore();
    store.railOn = true;
    const first = store.learn(50_000_000n, RESERVED);
    const second = store.learn(5_000_000n, RESERVED);
    // A third look at the new amount joins its load rather than starting another: two quotes
    // in all, asserted below.
    const third = store.learn(5_000_000n, RESERVED);
    expect(store.awaitingNetworks).toBe(true);
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
    await store.learn(50_000_000n, RESERVED);
    vi.advanceTimersByTime(FLOORS_STALE_MS);
    const refresh = store.learn(50_000_000n, RESERVED);
    expect(store.offerFor(btc)).toEqual(AVAILABLE); // the old answer stands meanwhile
    expect(store.awaitingNetworks).toBe(false);
    release(everyOffer(TOO_SMALL));
    await refresh;
    expect(store.offerFor(btc)).toEqual(TOO_SMALL);
  });

  it("quotes one destination again and writes the answer into the rows of the same pair", async () => {
    quote
      .mockResolvedValueOnce(everyOffer(AVAILABLE))
      .mockResolvedValue(new Map([[btc.id, TOO_SMALL]]));
    const store = useWithdrawOffersStore();
    store.railOn = true;
    await store.learn(50_000_000n, RESERVED);
    // Another pair's answer is returned, and the rows stay.
    expect(await store.requote(btc, 50_000_000n, RESERVED + 1n)).toEqual(TOO_SMALL);
    expect(store.offerFor(btc)).toEqual(AVAILABLE);
    expect(await store.requote(btc, 50_000_000n, RESERVED)).toEqual(TOO_SMALL);
    expect(quote).toHaveBeenLastCalledWith(50_000_000n, [btc], RESERVED);
    expect(store.offerFor(btc)).toEqual(TOO_SMALL);
    expect(store.offerFor(withdrawDestination("usdc-eth")!)).toEqual(AVAILABLE);
  });

  it("asks nothing while the rail is off, and says so on every provider row", async () => {
    const store = useWithdrawOffersStore();
    store.railOn = false;
    await store.learn(50_000_000n, RESERVED);
    expect(quote).not.toHaveBeenCalled();
    expect(store.awaitingNetworks).toBe(false);
    expect(store.rowFor(btc).subtitle).toBe("Not available yet");
    expect(store.rowFor(assetHub)).toEqual({ pickable: true });
  });

  it("starts with the rail off in a build with no broker key, and on with one", () => {
    try {
      vi.stubEnv("VITE_CHAINFLIP_BROKER_API_KEY", "");
      const without = useWithdrawOffersStore();
      expect(without.railOn).toBe(false);
      expect(without.rowFor(btc).subtitle).toBe("Not available yet");
      expect(without.rowFor(assetHub)).toEqual({ pickable: true });

      vi.stubEnv("VITE_CHAINFLIP_BROKER_API_KEY", "abc123");
      setActivePinia(createPinia());
      expect(useWithdrawOffersStore().railOn).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
