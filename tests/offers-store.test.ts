// The offers store projects the learned floors and the amount on screen into the networks and
// tokens to show. These seed the floors directly.

import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { SourceId } from "@getsome/core";
import type { SourceFloorResult } from "@getsome/chainflip";
import { useOffersStore } from "../app/stores/offers";
import { useSessionStore } from "../app/stores/session";

const DOT = 10_000_000_000n;

function floor(sourceId: SourceId, minimumBaseUnits: bigint, worthDot: bigint): SourceFloorResult {
  return {
    kind: "floor",
    floor: {
      sourceId,
      minimumBaseUnits,
      minimumEgressBaseUnits: worthDot * DOT,
      etaSeconds: 600,
    },
  };
}

/** A 50 CASH purchase the pool sized at 100 DOT. */
function sized(session: ReturnType<typeof useSessionStore>, nativeAmount: bigint | null) {
  session.setAmount("50");
  session.loading = false;
  session.quoted = { send: "", symbol: "DOT", nativeAmount, sourceAsset: null, sourceChain: null };
}

const LEARNED = new Map<SourceId, SourceFloorResult>([
  ["btc", floor("btc", 40_000n, 160n)], // needs 160 DOT: too small for 100
  ["eth", floor("eth", 10n ** 16n, 25n)], // 25 DOT: fine
  ["usdc-eth", { kind: "unavailable", reason: "Quoting is currently unavailable" }],
  ["usdt-eth", floor("usdt-eth", 20_000_000n, 5n)],
  ["sol-solana", floor("sol-solana", 68_000_000n, 200n)],
  ["usdc-solana", floor("usdc-solana", 10_000_000n, 300n)],
  ["usdt-solana", floor("usdt-solana", 10_000_000n, 400n)],
  ["trx-tron", { kind: "unavailable", reason: "Chainflip lists no minimum for Tron TRX" }],
  ["usdt-tron", { kind: "unavailable", reason: "Quoting is currently unavailable" }],
]);

describe("offers store", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("is checking everything until the floors are learned", () => {
    const session = useSessionStore();
    const offers = useOffersStore();
    sized(session, 100n * DOT);
    expect(offers.networks.every((n) => n.checking && !n.available)).toBe(true);
    expect(offers.offeredNetworks).toHaveLength(4); // still worth showing, as pending
    expect(offers.paused).toBe(false);
  });

  it("offers only the networks with a token that clears its floor, tokens likewise", () => {
    const session = useSessionStore();
    const offers = useOffersStore();
    sized(session, 100n * DOT);
    offers.floors = LEARNED;

    expect(offers.offeredNetworks.map((n) => n.chain)).toEqual(["Ethereum"]);
    expect(offers.offeredTokens("Ethereum").map((t) => t.asset)).toEqual(["ETH", "USDT"]);
    expect(offers.offeredTokens("Bitcoin")).toEqual([]);
    expect(offers.paused).toBe(false);

    const eth = offers.offeredTokens("Ethereum")[0]!.offer;
    expect(eth.state).toBe("available");
    if (eth.state !== "available") return;
    // 100 DOT at 0.01 ETH per 25 DOT = 0.04 ETH, plus the 5% buffer.
    expect(eth.offer.sendBaseUnits).toBe(42_000_000_000_000_000n);
    expect(eth.offer.sendFormatted).toBe("0.042");
    expect(eth.offer.etaSeconds).toBe(600);
  });

  it("says how small is too small, in CASH", () => {
    const session = useSessionStore();
    const offers = useOffersStore();
    sized(session, 100n * DOT);
    offers.floors = LEARNED;
    const bitcoin = offers.networks.find((n) => n.chain === "Bitcoin")!;
    expect(bitcoin.available).toBe(false);
    expect(bitcoin.checking).toBe(false);
    const btc = bitcoin.tokens[0]!.offer;
    expect(btc.state).toBe("too-small");
    // 50 CASH bought 100 DOT and the floor is worth 160 DOT: the smallest purchase is 80 CASH.
    if (btc.state === "too-small") expect(btc.minimumCashBase).toBe(80_000_000n);
  });

  it("keeps a source Chainflip could not answer for out of the offer, with its reason", () => {
    const session = useSessionStore();
    const offers = useOffersStore();
    sized(session, 100n * DOT);
    offers.floors = LEARNED;
    const usdc = offers.networks
      .find((n) => n.chain === "Ethereum")!
      .tokens.find((t) => t.asset === "USDC")!.offer;
    expect(usdc).toEqual({ state: "unavailable", reason: "Quoting is currently unavailable" });
  });

  it("offers everything ungated when the pool could not size the purchase", () => {
    const session = useSessionStore();
    const offers = useOffersStore();
    sized(session, null);
    offers.floors = LEARNED;
    expect(offers.offeredNetworks.map((n) => n.chain)).toEqual(["Bitcoin", "Ethereum", "Solana"]);
    expect(offers.offeredTokens("Bitcoin")[0]!.offer).toEqual({ state: "ungated" });
    // Chainflip's own no is still a no.
    expect(offers.offeredTokens("Tron")).toEqual([]);
  });

  it("is paused when Chainflip answered for nothing", () => {
    const session = useSessionStore();
    const offers = useOffersStore();
    offers.demoFallback = false; // a real build
    sized(session, 100n * DOT);
    offers.floors = new Map(
      [...LEARNED.keys()].map((id) => [id, { kind: "unavailable", reason: "maintenance" }]),
    );
    expect(offers.paused).toBe(true);
    expect(offers.offeredNetworks).toEqual([]);
  });

  // TODO(production): delete with the fallback.
  it("carries on ungated in a demo build when Chainflip answered for nothing", () => {
    const session = useSessionStore();
    const offers = useOffersStore();
    offers.demoFallback = true;
    sized(session, 100n * DOT);
    offers.floors = new Map(
      [...LEARNED.keys()].map((id) => [id, { kind: "unavailable", reason: "maintenance" }]),
    );
    expect(offers.paused).toBe(true); // still the truth about Chainflip
    expect(offers.offeredNetworks.map((n) => n.chain)).toEqual([
      "Bitcoin",
      "Ethereum",
      "Solana",
      "Tron",
    ]); // the demo proceeds with every token offered without a figure
    expect(offers.offeredTokens("Ethereum").map((t) => t.offer.state)).toEqual([
      "ungated",
      "ungated",
      "ungated",
    ]);
  });

  it("does not let the demo fallback mask a single source Chainflip refused", () => {
    const session = useSessionStore();
    const offers = useOffersStore();
    offers.demoFallback = true;
    sized(session, 100n * DOT);
    offers.floors = LEARNED; // only some sources unavailable: not paused
    expect(offers.paused).toBe(false);
    expect(offers.offeredTokens("Ethereum").map((t) => t.asset)).toEqual(["ETH", "USDT"]);
  });
});
