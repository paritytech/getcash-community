// A hosted Polkadot pick runs under its own source, on the route its token names. The demo's Skip
// then has the faucet send the burner the figure the deposit itself asks.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createManualRail, type ConversionRoute } from "@getsome/funding";
import { createFakeRail } from "@getsome/testing";
import {
  createMemoryKeyedStorage,
  setMirrorStorage,
  setRecordStorage,
  type WebStorageLike,
} from "../app/funding/requests/storage";
import { useRequestsStore } from "../app/stores/requests";
import { useSessionStore } from "../app/stores/session";

const BURNER = "14uAyRtbeRsrgERPLETm72yFPKW3oi3m4RX93arNwGQhsduC";
/** What the deposit must land on the burner, in PAS. */
const BUDGET = 58_694_260_960n;
/** What the next world sizes its budget at; a test moves it to stand for a rebuild on reopen. */
const sizing = { budget: BUDGET };
/** Set, the error the next world's rail refuses its quote with. */
const refusal = { error: null as Error | null };

const { worlds, faucet, manager } = vi.hoisted(() => ({
  worlds: {
    builds: [] as { sourceId?: string; tradeN?: number; tier: string }[],
    disposed: 0,
  },
  faucet: { calls: [] as unknown[] },
  manager: { isAvailable: () => true, call: async () => {}, dispose() {} },
}));
vi.mock("../lib/host-account", () => ({ isHosted: () => true }));
vi.mock("../lib/worker-rpc", () => ({ getStorageWorkerManager: () => manager }));
vi.mock("../lib/faucet", () => ({
  isFaucetConfigured: () => true,
  fundFromFaucet: async (args: unknown) => {
    faucet.calls.push(args);
  },
}));
// The hosted world over the offline fakes: the deposit goes straight to the burner, the budget is
// given.
vi.mock("../lib/coinage-live", async () => {
  const { createMockCoinageSession, depositTokenOf } = await import("../lib/coinage");
  return {
    chooseHostedRoute: async () => ({ tier: "pool" }),
    nextHostedTradeNumber: async () => 1,
    ensureChainSubmitGrant: async () => {},
    // The requests store's own reads: the counter behind the gap sweep, a number with no flow
    // slot, an empty burner, so no lost request to recover, and watches that never report a
    // change.
    readHostedTradeCounter: async () => 1,
    readFlowSlot: async () => ({ address: BURNER, slot: null }),
    probeTradeBurner: async () => ({ address: BURNER, free: 0n }),
    lostRequestHandoff: async () => {
      throw new Error("no lost request to recover");
    },
    watchDirectTradeBurner: async () => () => {},
    watchTradeBurner: async () => () => {},
    createHostedCoinageWorld: async (args: {
      amount: bigint;
      route: ConversionRoute;
      sourceId?: string;
      tradeN?: number;
    }) => {
      worlds.builds.push({ sourceId: args.sourceId, tradeN: args.tradeN, tier: args.route.tier });
      const mock = await createMockCoinageSession({
        recipient: BURNER,
        amount: args.amount,
        sourceId: (args.sourceId ?? "dot-assethub") as never,
        tradeN: args.tradeN,
        route: args.route,
        nativeBudget: BUDGET,
        rail:
          refusal.error === null
            ? createManualRail({ token: depositTokenOf(args.route) })
            : createFakeRail({ quoteError: refusal.error }),
      });
      return {
        ...mock,
        burnerAddress: BURNER,
        budget: sizing.budget,
        runFunding: async () => {},
        readPurse: async () => 0n,
        readBurnerDepositOnAh: async () => 0n,
        exportBurnerSecret: async () => "0x",
        dispose: () => {
          worlds.disposed += 1;
          mock.session.dispose();
        },
      };
    },
  };
});

function fakeWebStorage(): WebStorageLike {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

/** Quotes 50 CASH from DOT. */
async function quoteDot() {
  const session = useSessionStore();
  session.setAmount("50");
  await session.fetchQuote("Polkadot", "DOT");
  return session;
}

describe("a hosted Polkadot pick", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setRecordStorage(createMemoryKeyedStorage());
    setMirrorStorage(fakeWebStorage());
    worlds.builds.length = 0;
    worlds.disposed = 0;
    faucet.calls.length = 0;
    sizing.budget = BUDGET;
    refusal.error = null;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    const requests = useRequestsStore();
    requests.stopJobPoll();
    await requests.flush();
    vi.restoreAllMocks();
    setMirrorStorage(null);
  });

  it("runs under its own source and opens the deposit on the burner", async () => {
    const session = await quoteDot();
    const requests = useRequestsStore();
    expect(session.quoteError).toBeNull();
    expect(worlds.builds).toEqual([{ sourceId: "dot-assethub", tradeN: 1, tier: "pool" }]);
    expect(session.quoted).toMatchObject({
      symbol: "DOT",
      sourceAsset: "DOT",
      sourceChain: "Polkadot",
    });
    await session.start();
    expect(requests.phase).toBe("awaiting-deposit");
    expect(requests.foregroundRecord).toMatchObject({ rail: { provider: "manual" } });
  });

  it("fails the quote its world refuses, and lets the world go", async () => {
    refusal.error = new Error("the rail has no quote");
    const session = await quoteDot();
    expect(session.quoteError).toBe("the rail has no quote");
    expect(session.quoteFailures).toBe(1);
    expect(session.live).toBeNull();
    expect(worlds.disposed).toBe(1);
  });

  // TODO(production): delete with the faucet and fundFaucet.
  it("Skip sends the figure the deposit asks, not the world's sizing", async () => {
    // A world rebuilt on reopen sizes the budget again, and the pool may have moved; the deposit
    // still asks, and is checked against, the figure it was opened with.
    sizing.budget = BUDGET + 1n;
    const session = await quoteDot();
    await session.start();
    await session.fundFaucet();
    expect(faucet.calls).toEqual([{ address: BURNER, amount: BUDGET, route: { tier: "pool" } }]);
  });
});
