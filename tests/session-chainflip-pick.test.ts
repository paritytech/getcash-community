// A hosted Chainflip pick runs under its own source and opens the rail's channel to the burner.
// The demo's Skip then has the faucet send the burner what the rail would have delivered; on a
// Polkadot deposit, the figure the deposit itself asks.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { TOKENS } from "@getsome/core";
import { SourceMinimumNotMetError } from "@getsome/chainflip";
import { createManualRail } from "@getsome/funding";
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
/** What the rail must deliver to the burner, in PAS. */
const BUDGET = 58_694_260_960n;
/** What the next world sizes its budget at; a test moves it to stand for a rebuild on reopen. */
const sizing = { budget: BUDGET };
/** Set, the fakes' rail refuses the next quote with it: the pick is under Chainflip's floor. */
const floor = { error: null as Error | null };

const { worlds, faucet, manager } = vi.hoisted(() => ({
  worlds: { builds: [] as { sourceId?: string; tradeN?: number }[] },
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
// The hosted world over the offline fakes: the fake rail opens the channel, the budget is given.
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
      route: { tier: "pool" };
      sourceId?: string;
      tradeN?: number;
    }) => {
      worlds.builds.push({ sourceId: args.sourceId, tradeN: args.tradeN });
      // A Polkadot pick deposits straight to the burner; every other runs on the fakes' rail,
      // which refuses when a test puts the pick under its floor.
      const rail =
        args.sourceId === "dot-assethub"
          ? createManualRail({ token: depositTokenOf(args.route) })
          : floor.error === null
            ? undefined
            : createFakeRail({ quoteError: floor.error });
      const mock = await createMockCoinageSession({
        recipient: BURNER,
        amount: args.amount,
        sourceId: (args.sourceId ?? "dot-assethub") as never,
        tradeN: args.tradeN,
        route: args.route,
        nativeBudget: BUDGET,
        ...(rail === undefined ? {} : { rail }),
      });
      return {
        ...mock,
        burnerAddress: BURNER,
        budget: sizing.budget,
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

/** Quotes 50 CASH from the pick and starts the request. */
async function startTopUp(chain: string, asset: string) {
  const session = useSessionStore();
  const requests = useRequestsStore();
  session.setAmount("50");
  await session.fetchQuote(chain, asset);
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
    sizing.budget = BUDGET;
    floor.error = null;
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
    const { session, requests } = await startTopUp("Bitcoin", "BTC");
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

  it("a pick under its floor sizes the picker without an error and opens nothing", async () => {
    floor.error = new SourceMinimumNotMetError({
      sourceId: "btc",
      assetSymbol: "BTC",
      minimumBaseUnits: 100_000n,
      minimumFormatted: "0.001",
      neededBaseUnits: 50_000n,
      neededFormatted: "0.0005",
    });
    const session = useSessionStore();
    const requests = useRequestsStore();
    session.setAmount("50");
    await session.fetchQuote("Bitcoin", "BTC");
    // No error card: the budget the world sized is what the picker greys the row against.
    expect(session.quoteError).toBeNull();
    expect(session.quoted).toMatchObject({
      nativeAmount: BUDGET,
      depositToken: TOKENS.PAS,
      sourceAsset: "BTC",
      symbol: "BTC",
    });
    expect(session.sourcePrice).toEqual({
      kind: "minimum",
      minimum: {
        minimumFormatted: "0.001",
        assetSymbol: "BTC",
        minimumBaseUnits: 100_000n,
        neededBaseUnits: 50_000n,
        neededFormatted: "0.0005",
      },
    });
    // The world and its burner are let go, so a start opens nothing.
    expect(session.live).toBeNull();
    await session.start();
    expect(requests.phase).toBeNull();
  });

  // TODO(production): delete with the faucet and fundFaucet.
  it("Skip has the faucet send the burner the budget, in the route's token", async () => {
    const { session } = await startTopUp("Bitcoin", "BTC");
    await session.fundFaucet();
    expect(faucet.calls).toEqual([{ address: BURNER, amount: BUDGET, route: { tier: "pool" } }]);
  });

  // TODO(production): delete with the faucet and fundFaucet.
  it("Skip on a Polkadot deposit sends the figure the deposit asks, not the world's sizing", async () => {
    // A world rebuilt on reopen sizes the budget again, and the pool may have moved; the deposit
    // still asks, and is checked against, the figure it was opened with.
    sizing.budget = BUDGET + 1n;
    const { session } = await startTopUp("Polkadot", "DOT");
    await session.fundFaucet();
    expect(faucet.calls).toEqual([{ address: BURNER, amount: BUDGET, route: { tier: "pool" } }]);
  });
});
