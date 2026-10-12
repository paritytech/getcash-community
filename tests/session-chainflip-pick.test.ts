// A hosted Chainflip pick runs under its own source and opens the rail's channel to the burner.
// The demo's Skip then has the faucet send the burner what the rail would have delivered.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { TOKENS } from "@getsome/core";
import {
  createMemoryKeyedStorage,
  setMirrorStorage,
  setRecordStorage,
  type WebStorageLike,
} from "../app/funding/requests/storage";
import { useRequestsStore } from "../app/stores/requests";
import { useSessionStore } from "../app/stores/session";

const BURNER = "14uAyRtbeRsrgERPLETm72yFPKW3oi3m4RX93arNwGQhsduC";
/** What the rail must deliver to the burner, in PAS. */
const BUDGET = 58_694_260_960n;

const { worlds, faucet, manager } = vi.hoisted(() => ({
  worlds: { builds: [] as { sourceId?: string; tradeN?: number }[] },
  faucet: { calls: [] as unknown[] },
  manager: { isAvailable: () => true, call: async () => {}, dispose() {} },
}));
vi.mock("../lib/host-account", () => ({ isHosted: () => true }));
vi.mock("../lib/worker-rpc", () => ({ getStorageWorkerManager: () => manager }));
vi.mock("../lib/faucet", () => ({
  isFaucetConfigured: () => true,
  fundFromFaucet: async (args: { amount: bigint }) => {
    faucet.calls.push(args);
    return args.amount;
  },
}));
// The hosted world over the offline fakes: the fake rail opens the channel, the budget is given.
vi.mock("../lib/coinage-live", async () => {
  const { createMockCoinageSession } = await import("../lib/coinage");
  return {
    chooseHostedRoute: async () => ({ tier: "pool" }),
    nextHostedTradeNumber: async () => 1,
    ensureChainSubmitGrant: async () => {},
    createHostedCoinageWorld: async (args: {
      amount: bigint;
      route: { tier: "pool" };
      sourceId?: string;
      tradeN?: number;
    }) => {
      worlds.builds.push({ sourceId: args.sourceId, tradeN: args.tradeN });
      const mock = await createMockCoinageSession({
        recipient: BURNER,
        amount: args.amount,
        sourceId: (args.sourceId ?? "dot-assethub") as never,
        tradeN: args.tradeN,
        route: args.route,
        nativeBudget: BUDGET,
      });
      return {
        ...mock,
        burnerAddress: BURNER,
        budget: BUDGET,
        runFunding: async () => {},
        readPurse: async () => 0n,
        readBurnerDepositOnAh: async () => 0n,
        exportBurnerSecret: async () => "0x",
        dispose: () => mock.session.dispose(),
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

/** Quotes 50 CASH from the Bitcoin pill and starts the request. */
async function startBitcoinTopUp() {
  const session = useSessionStore();
  const requests = useRequestsStore();
  session.setAmount("50");
  await session.fetchQuote("Bitcoin", "BTC");
  expect(session.quoteError).toBeNull();
  await session.start();
  expect(requests.phase).toBe("awaiting-deposit");
  return { session, requests };
}

describe("a hosted Chainflip pick", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setRecordStorage(createMemoryKeyedStorage());
    setMirrorStorage(fakeWebStorage());
    worlds.builds.length = 0;
    faucet.calls.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    const requests = useRequestsStore();
    requests.stopJobPoll();
    await requests.flush();
    vi.restoreAllMocks();
    setMirrorStorage(null);
  });

  it("runs under its own source and opens the rail's channel to the burner", async () => {
    const { session, requests } = await startBitcoinTopUp();
    // The world runs under the pick's source, not the deposit token's.
    expect(worlds.builds).toEqual([{ sourceId: "btc", tradeN: 1 }]);
    // The rail's figure is what the buyer sends; the budget is what lands on the burner.
    expect(session.quoted).toMatchObject({
      send: "0.001 BTC",
      symbol: "BTC",
      nativeAmount: BUDGET,
      depositToken: TOKENS.PAS,
      sourceAsset: "BTC",
      sourceChain: "Bitcoin",
    });
    expect(session.sourcePrice).toEqual({
      kind: "price",
      price: { formatted: "0.001 BTC", baseUnits: 100_000n },
    });
    const record = requests.foregroundRecord;
    expect(record?.kind).toBe("top-up");
    if (record?.kind !== "top-up") return;
    expect(record.rail.provider).toBe("chainflip");
    expect(record.deposit?.address).toBe("bc1q-fake-deposit");
    // The channel refunds to the request's own Bitcoin key.
    expect(session.refundAddress).toMatch(/^bc1/);
    expect(record.refundAddress).toBe(session.refundAddress);
  });

  // TODO(production): delete with the faucet and fundFaucet.
  it("Skip has the faucet send the burner the budget, in the route's token", async () => {
    const { session, requests } = await startBitcoinTopUp();
    await session.fundFaucet();
    expect(faucet.calls).toEqual([{ address: BURNER, amount: BUDGET, route: { tier: "pool" } }]);
    expect(requests.fundsSeen).toBe(true);
  });
});
