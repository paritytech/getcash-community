// The entry flow's navigation: the network pick decides from the offers before it touches the
// source, and back retraces the path taken, whatever the quote is doing at the time.

import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { SourceId } from "@getsome/core";
import type { SourceFloorResult } from "@getsome/chainflip";
import { useFlowStore } from "../app/stores/flow";
import { useOffersStore } from "../app/stores/offers";
import { useSessionStore } from "../app/stores/session";

const DOT = 10_000_000_000n;

function floor(sourceId: SourceId, minimumBaseUnits: bigint, worthDot: bigint): SourceFloorResult {
  return {
    kind: "floor",
    floor: { sourceId, minimumBaseUnits, minimumEgressBaseUnits: worthDot * DOT, etaSeconds: 600 },
  };
}

/** A 50 CASH purchase the pool sized at 10 DOT: on Ethereum only USDT (a stablecoin) clears
 *  its floor, on Tron only TRX (the native coin) does, on Solana every token does, on Bitcoin
 *  nothing does. */
const LEARNED = new Map<SourceId, SourceFloorResult>([
  ["btc", floor("btc", 40_000n, 16n)],
  ["eth", floor("eth", 10n ** 16n, 25n)],
  ["usdc-eth", { kind: "unavailable", reason: "preview" }],
  ["usdt-eth", floor("usdt-eth", 20_000_000n, 5n)],
  ["sol-solana", floor("sol-solana", 68_000_000n, 1n)],
  ["usdc-solana", floor("usdc-solana", 10_000_000n, 1n)],
  ["usdt-solana", floor("usdt-solana", 10_000_000n, 1n)],
  ["trx-tron", floor("trx-tron", 30_000_000n, 1n)],
  ["usdt-tron", floor("usdt-tron", 10_000_000n, 25n)],
]);

function setUp() {
  setActivePinia(createPinia());
  const session = useSessionStore();
  const offers = useOffersStore();
  const flow = useFlowStore();
  session.setAmount("50");
  session.loading = false;
  session.quoted = {
    send: "",
    symbol: "DOT",
    nativeAmount: 10n * DOT,
    sourceAsset: null,
    sourceChain: null,
  };
  offers.floors = LEARNED;
  return { session, offers, flow };
}

describe("flow store: picking a network", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("skips the token screen and starts when the one offered token is the network's own coin", () => {
    const { flow } = setUp();
    expect(flow.pickNetwork("Tron")).toBeNull();
    expect(flow.srcChain.chain).toBe("Tron");
    expect(flow.srcAsset).toBe("TRX");
    expect(flow.starting).toBe(true);
  });

  it("still shows the token screen for a lone stablecoin, so the buyer sees what it is", () => {
    const { flow, offers } = setUp();
    expect(offers.offeredTokens("Ethereum").map((t) => t.asset)).toEqual(["USDT"]);
    expect(flow.pickNetwork("Ethereum")).toBe("token");
    expect(flow.srcChain.chain).toBe("Ethereum");
  });

  it("goes to the token screen when there is a choice, without re-quoting", () => {
    const { flow, session } = setUp();
    expect(flow.pickNetwork("Solana")).toBe("token");
    expect(flow.srcChain.chain).toBe("Solana");
    // No quote was torn down to get here: the token pick makes the one quote.
    expect(session.quoted).not.toBeNull();
    expect(session.loading).toBe(false);
  });

  it("decides from the offers as they were, not as a re-quote leaves them", () => {
    const { flow, offers } = setUp();
    // Coming from another chain: the pick reads the offers before any chain switch re-quotes them.
    flow.pickNetwork("Solana");
    expect(offers.offeredTokens("Tron").map((t) => t.asset)).toEqual(["TRX"]);
    expect(flow.pickNetwork("Tron")).toBeNull();
    expect(flow.srcAsset).toBe("TRX");
  });

  it("leaves the token screen in place when a start has nothing to start", async () => {
    const { flow, session } = setUp();
    flow.pickNetwork("Solana");
    flow.selectSource("Solana", "USDC");
    session.quoted = null; // the quote failed: no world, nothing to open
    await flow.startPurchase();
    expect(flow.starting).toBe(false);
    expect(flow.step).toBe("token");
    flow.back();
    expect(flow.step).toBe("network");
  });
});

describe("flow store: deep-linked source", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("preselects a known source and says so", () => {
    const { flow } = setUp();
    expect(flow.selectSourceId("usdt-tron")).toBe(true);
    expect(flow.srcChain.chain).toBe("Tron");
    expect(flow.srcAsset).toBe("USDT");
  });

  it("changes nothing for an unknown one, so the choosing is not skipped", () => {
    const { flow } = setUp();
    expect(flow.selectSourceId("moonbeam-glmr")).toBe(false);
    expect(flow.srcChain.chain).toBe("Bitcoin");
  });
});

describe("leaving a package", () => {
  it("resetEntry forgets the entry choices but keeps the amount (the request lives on)", () => {
    setActivePinia(createPinia());
    const session = useSessionStore();
    const flow = useFlowStore();
    session.setAmount("50");
    flow.step = "token";
    flow.resetEntry();
    expect(flow.step).toBe("amount");
    expect(session.amountHuman).toBe("50");
  });

  it("startOver also clears the amount", () => {
    setActivePinia(createPinia());
    const session = useSessionStore();
    const flow = useFlowStore();
    session.setAmount("50");
    flow.startOver();
    expect(flow.step).toBe("amount");
    expect(session.amountHuman).toBe("");
  });
});
