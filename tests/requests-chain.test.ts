// The chain step of a reconcile: tombstones and waiting requests nobody watches are read from the
// burner, and the trade numbers between the records and the counter are swept for lost requests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import type { FlowState } from "@getsome/core";
import { migrateRecord } from "../app/funding/requests/migrate";
import {
  setRequestsClock,
  TOMBSTONE_GRACE_MS,
  WORKER_STALE_MS,
  type RequestRecord,
  type WorkerHandoffPayload,
} from "../app/funding/requests/model";
import {
  createMemoryKeyedStorage,
  PROBED_KEY,
  REQUEST_INDEX_KEY,
  requestKey,
  setMirrorStorage,
  setRecordStorage,
  WORKER_JOBS_KEY,
  type KeyedStorage,
} from "../app/funding/requests/storage";
import { useRequestsStore } from "../app/stores/requests";
import type { ActiveFlowRecord } from "../app/stores/session";
import {
  parseRequestIndex,
  requestRefKey,
  requestRefOf,
  type RequestRef,
} from "../app/utils/request-index";
import {
  awaitingDepositCryptoRecord,
  cancelledCryptoRecord,
  FIXTURE_NOW,
  fixtureWorkerJobs,
  type WorkerJobRecord,
} from "./fixtures/requests";

// The chain step runs hosted only. Outside the Polkadot App the chain and the worker are
// stand-ins: burners answer from a table keyed `<sourceId>:<tradeN>`, the manager records its
// calls.
const { chain, worker, manager, lostRequestHandoff } = vi.hoisted(() => {
  const addressOf = (key: string) => `burner-${key}`;
  const chain = {
    /** What a burner read answers: a balance, or the error it throws. Absent means empty. */
    burners: new Map<string, { address: string; free: bigint } | Error>(),
    /** Every burner read, in order. */
    probes: [] as string[],
    /** Every burner subscription, in order; the test pushes balances through `onValue`. */
    watchers: [] as {
      key: string;
      onValue: (free: bigint, address: string) => void;
      onError: (e: unknown) => void;
      unsubscribed: boolean;
    }[],
    counters: new Map<string, number>(),
    slots: new Map<string, FlowState>(),
    address: addressOf,
  };
  const worker = { available: true, calls: [] as { api: string; payload: unknown }[] };
  const manager = {
    isAvailable: () => worker.available,
    call: async (api: string, payload?: unknown) => {
      worker.calls.push({ api, payload });
    },
    dispose() {},
  };
  const lostRequestHandoff = (
    sourceId: string,
    tradeN: number,
    address: string,
    slot: FlowState,
  ): WorkerHandoffPayload => ({
    label: `onramp:eph:${sourceId}:${tradeN}`,
    burnerAddress: address,
    depositExpiresAt: slot.depositExpiresAt ?? 0,
    settleAmount: slot.handoffAmount ?? "0",
    underlyingAssetId: 1337,
    peopleParaId: 1004,
    assetHubGenesis: `0x${"aa".repeat(32)}`,
    peopleGenesis: `0x${"bb".repeat(32)}`,
    remoteFeeBuffer: "500000000",
    keepNativeForFees: "100000000",
  });
  return { chain, worker, manager, lostRequestHandoff };
});
vi.mock("../lib/host-account", () => ({ isHosted: () => true }));
vi.mock("../lib/worker-rpc", () => ({ getStorageWorkerManager: () => manager }));
vi.mock("../lib/coinage-live", () => ({
  probeTradeBurner: async (sourceId: string, tradeN: number) => {
    const key = `${sourceId}:${tradeN}`;
    chain.probes.push(key);
    const answer = chain.burners.get(key);
    if (answer instanceof Error) throw answer;
    return answer ?? { address: chain.address(key), free: 0n };
  },
  watchTradeBurner: async (
    sourceId: string,
    tradeN: number,
    onValue: (free: bigint, address: string) => void,
    onError: (e: unknown) => void,
  ) => {
    const watcher = { key: `${sourceId}:${tradeN}`, onValue, onError, unsubscribed: false };
    chain.watchers.push(watcher);
    return () => {
      watcher.unsubscribed = true;
    };
  },
  burnerAddressFor: async (sourceId: string, tradeN: number) =>
    chain.address(`${sourceId}:${tradeN}`),
  readHostedTradeCounter: async (sourceId: string) => chain.counters.get(sourceId) ?? 1,
  readFlowSlot: async (sourceId: string, tradeN: number) => {
    const key = `${sourceId}:${tradeN}`;
    return { address: chain.address(key), slot: chain.slots.get(key) ?? null };
  },
  lostRequestHandoff,
  ensureChainSubmitGrant: async () => {},
  createHostedCoinageWorld: async () => {
    throw new Error("no world is built here");
  },
}));

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** The ref a fixture is stored under: its own source id and trade number. */
const refOf = (record: ActiveFlowRecord): RequestRef =>
  requestRefOf(record.sourceId, record.tradeN!);

const migrated = (record: ActiveFlowRecord): RequestRecord => {
  const result = migrateRecord(record, refOf(record), FIXTURE_NOW);
  if (result === null) throw new Error("fixture did not migrate");
  return result;
};

/** The hand-off a request stored when it started: the fields the worker keeps on its job. */
function handoffOf(job: WorkerJobRecord): WorkerHandoffPayload {
  return {
    label: job.label,
    burnerAddress: job.burnerAddress,
    depositExpiresAt: job.depositExpiresAt ?? 0,
    settleAmount: job.settleAmount,
    underlyingAssetId: job.underlyingAssetId,
    peopleParaId: job.peopleParaId,
    assetHubGenesis: job.assetHubGenesis,
    peopleGenesis: job.peopleGenesis,
    remoteFeeBuffer: job.remoteFeeBuffer,
    keepNativeForFees: job.keepNativeForFees,
  };
}

/** A cancelled crypto request under another trade number, its window closing at `expiresAt`. */
const tombstone = (tradeN: number, expiresAt: number): RequestRecord =>
  migrated({ ...cancelledCryptoRecord, tradeN, depositExpiresAt: expiresAt });

const AWAITING_REF = refOf(awaitingDepositCryptoRecord);
const AWAITING_JOB = fixtureWorkerJobs["dot-assethub:3"]!;
const AWAITING_HANDOFF = handoffOf(AWAITING_JOB);

let host: KeyedStorage;

/** Replaces the worker's blob, as the worker does on its own tick. */
function writeJobs(jobs: Record<string, WorkerJobRecord>): Promise<void> {
  return host.write(WORKER_JOBS_KEY, JSON.stringify(jobs));
}

async function storedIndex(): Promise<RequestRef[]> {
  return parseRequestIndex(await host.read(REQUEST_INDEX_KEY));
}

/** Lets the deposit watch's subscribe, or an observation it made, run to its end: both are
 *  promise chains behind the store's synchronous calls. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The subscriptions so far, as key and whether each is still live. */
const watchers = () => chain.watchers.map(({ key, unsubscribed }) => ({ key, unsubscribed }));

describe("requests store: the chain step", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    host = createMemoryKeyedStorage();
    setRecordStorage(host);
    setMirrorStorage(null);
    setRequestsClock(() => FIXTURE_NOW);
    chain.burners.clear();
    chain.probes.length = 0;
    chain.watchers.length = 0;
    chain.counters.clear();
    chain.slots.clear();
    worker.available = true;
    worker.calls.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    // Neither a poll nor a coalesced write may outlive its test.
    const requests = useRequestsStore();
    requests.leave();
    requests.stopJobPoll();
    await requests.flush();
    vi.useRealTimers();
    vi.restoreAllMocks();
    setRequestsClock(Date.now);
  });

  it("tombstone with funds is resurrected; empty past grace is removed; read failure keeps it", async () => {
    const requests = useRequestsStore();
    const FUNDED_REF = requestRefOf("dot-assethub", 1);
    const EMPTY_REF = requestRefOf("dot-assethub", 2);
    const UNREAD_REF = requestRefOf("dot-assethub", 3);
    await requests.create(FUNDED_REF, tombstone(1, FIXTURE_NOW + 22 * 60 * MINUTE));
    await requests.create(EMPTY_REF, tombstone(2, FIXTURE_NOW - TOMBSTONE_GRACE_MS - MINUTE));
    await requests.create(UNREAD_REF, tombstone(3, FIXTURE_NOW + 22 * 60 * MINUTE));
    chain.burners.set("dot-assethub:1", { address: "burner-1", free: 5_000_000_000n });
    chain.burners.set("dot-assethub:3", new Error("asset hub unreachable"));

    await requests.reconcile("boot");

    expect(chain.probes.sort()).toEqual(["dot-assethub:1", "dot-assethub:2", "dot-assethub:3"]);
    // Money on a cancelled burner: the request is a funded open request again.
    expect(requests.get(FUNDED_REF)).toMatchObject({
      status: { kind: "deposit-seen", via: "chain", assurance: "provisional" },
      witnesses: { chain: { best: { burnerNative: "5000000000", at: FIXTURE_NOW } } },
    });
    expect(requests.get(FUNDED_REF)).not.toHaveProperty("cancelledAt");
    // Confirmed empty past the window and the grace: gone from memory, the host and the index.
    expect(requests.entries).not.toHaveProperty(requestRefKey(EMPTY_REF));
    expect(await host.read(requestKey(EMPTY_REF))).toBeNull();
    expect(await storedIndex()).toEqual([UNREAD_REF, FUNDED_REF]);
    // A read that failed proves nothing: the tombstone stays.
    expect(requests.get(UNREAD_REF)).toMatchObject({ status: { kind: "cancelled" } });
    expect(await host.read(requestKey(UNREAD_REF))).not.toBeNull();
  });

  it("waiting entry is read only when the worker is stale or unknown", async () => {
    const requests = useRequestsStore();
    await requests.create(AWAITING_REF, {
      ...migrated(awaitingDepositCryptoRecord),
      handoff: AWAITING_HANDOFF,
    });

    // The worker ticked the job a second ago: it is reading that burner itself.
    await writeJobs({ "dot-assethub:3": { ...AWAITING_JOB, lastTickAt: FIXTURE_NOW - 1_000 } });
    await requests.reconcile("refresh");
    expect(chain.probes).toEqual([]);

    // The job's last tick is older than the stale bound.
    await writeJobs({
      "dot-assethub:3": { ...AWAITING_JOB, lastTickAt: FIXTURE_NOW - WORKER_STALE_MS - 1 },
    });
    await requests.reconcile("refresh");
    expect(chain.probes).toEqual(["dot-assethub:3"]);

    // The worker has no job for the request.
    await writeJobs({});
    await requests.reconcile("refresh");
    expect(chain.probes).toEqual(["dot-assethub:3", "dot-assethub:3"]);

    // The job is fresh, but the worker's own heartbeat is not.
    await writeJobs({ "dot-assethub:3": { ...AWAITING_JOB, lastTickAt: FIXTURE_NOW - 1_000 } });
    worker.available = false;
    await requests.reconcile("refresh");
    expect(chain.probes).toEqual(["dot-assethub:3", "dot-assethub:3", "dot-assethub:3"]);
    // Every read found the burner empty: the record only witnessed them.
    expect(requests.get(AWAITING_REF)).toMatchObject({
      rev: 0,
      status: { kind: "awaiting-deposit" },
      witnesses: { chain: { best: { burnerNative: "0", at: FIXTURE_NOW } } },
    });
  });

  it("gap sweep reads a lost number once, records empty, creates a record when funded", async () => {
    const requests = useRequestsStore();
    // Records up to trade 3, the worker's job for 4 (a cancelled request whose tombstone is
    // gone), and a counter that says 5 and 6 were taken too.
    await requests.create(AWAITING_REF, {
      ...migrated(awaitingDepositCryptoRecord),
      handoff: AWAITING_HANDOFF,
    });
    await writeJobs({
      "dot-assethub:3": { ...AWAITING_JOB, lastTickAt: FIXTURE_NOW - 1_000 },
      "dot-assethub:4": {
        ...fixtureWorkerJobs["dot-assethub:4"]!,
        phase: "failed",
        failure: "cancelled",
        done: true,
      },
    });
    chain.counters.set("dot-assethub", 7);
    const LOST_REF = requestRefOf("dot-assethub", 6);
    const startedAt = FIXTURE_NOW - 10 * MINUTE;
    const slot: FlowState = {
      version: 2,
      mode: "handoff",
      sourceId: "dot-assethub",
      recipient: "burner-dot-assethub:6",
      ephemeralAddress: "burner-dot-assethub:6",
      phase: "awaiting-deposit",
      createdAt: startedAt,
      idempotencyKey: "fixture-6",
      payload: "",
      priceEvm: "0",
      handoffAmount: "12000000",
      settlement: { kind: "native" },
      depositAddress: "burner-dot-assethub:6",
      depositAmount: "30000000000",
      depositFormatted: "3 DOT",
      depositAssetSymbol: "DOT",
      depositExpiresAt: startedAt + DAY,
    };
    chain.slots.set("dot-assethub:6", slot);
    chain.burners.set("dot-assethub:6", {
      address: "burner-dot-assethub:6",
      free: 30_000_000_000n,
    });

    await requests.reconcile("boot");

    expect(chain.probes.sort()).toEqual(["dot-assethub:5", "dot-assethub:6"]);
    // 5 was empty: noted, so it is not read again for a day.
    expect(JSON.parse((await host.read(PROBED_KEY))!)).toEqual({
      schema: 1,
      "dot-assethub": { "5": { firstAt: FIXTURE_NOW, lastAt: FIXTURE_NOW } },
    });
    // 6 holds funds and core's slot knows the amount: a record, funded by the chain's read, and
    // handed to the worker on the same pass.
    const handoff = lostRequestHandoff("dot-assethub", 6, "burner-dot-assethub:6", slot);
    expect(requests.get(LOST_REF)).toMatchObject({
      schema: 2,
      ref: LOST_REF,
      amountHuman: "12",
      chain: "AssetHub",
      asset: "DOT",
      startedAt,
      depositAddress: "burner-dot-assethub:6",
      deposit: {
        address: "burner-dot-assethub:6",
        amount: "30000000000",
        formatted: "3 DOT",
        assetSymbol: "DOT",
        expiresAt: startedAt + DAY,
      },
      deadline: { depositExpiresAt: startedAt + DAY, source: "rail" },
      handoff,
      status: { kind: "deposit-seen", via: "chain", assurance: "provisional" },
    });
    expect(worker.calls).toEqual([
      { api: "startFunding", payload: { sessionId: "dot-assethub:6", ...handoff } },
    ]);
    expect(await storedIndex()).toEqual([LOST_REF, AWAITING_REF]);

    // The same boot again: 5 is noted and 6 is a record now; nothing is read.
    chain.probes.length = 0;
    await requests.reconcile("boot");
    expect(chain.probes).toEqual([]);
    // A refresh never sweeps the gaps.
    chain.counters.set("dot-assethub", 9);
    await requests.reconcile("refresh");
    expect(chain.probes).toEqual([]);
  });

  it("the deposit watch subscribes to the burner at a best block and ends once the deposit is seen", async () => {
    const requests = useRequestsStore();
    await requests.create(AWAITING_REF, {
      ...migrated(awaitingDepositCryptoRecord),
      handoff: AWAITING_HANDOFF,
    });
    requests.setForeground(AWAITING_REF);
    await nextTick();
    await settled();
    expect(watchers()).toEqual([{ key: "dot-assethub:3", unsubscribed: false }]);
    const watcher = chain.watchers[0]!;

    // An empty burner: the record only witnessed the reading, and the watch goes on.
    watcher.onValue(0n, "burner-3");
    await settled();
    expect(requests.get(AWAITING_REF)).toMatchObject({
      rev: 0,
      status: { kind: "awaiting-deposit" },
      witnesses: { chain: { best: { burnerNative: "0", at: FIXTURE_NOW } } },
    });
    expect(watcher.unsubscribed).toBe(false);

    // The coins show: the app is the early witness, provisionally, the journey moves on and the
    // watch ends; the worker's finalized sighting follows on its own.
    watcher.onValue(5_000_000_000n, "burner-3");
    await settled();
    expect(requests.get(AWAITING_REF)).toMatchObject({
      rev: 1,
      status: { kind: "deposit-seen", at: FIXTURE_NOW, assurance: "provisional", via: "chain" },
      funded: FIXTURE_NOW,
      progress: { routeCompletedAt: FIXTURE_NOW },
      witnesses: { chain: { best: { burnerNative: "5000000000", at: FIXTURE_NOW } } },
    });
    expect(watcher.unsubscribed).toBe(true);

    // A late emission after the stop changes nothing, and nothing re-subscribes.
    watcher.onValue(7_000_000_000n, "burner-3");
    await settled();
    expect(requests.get(AWAITING_REF)).toMatchObject({
      rev: 1,
      witnesses: { chain: { best: { burnerNative: "5000000000", at: FIXTURE_NOW } } },
    });
    expect(watchers()).toEqual([{ key: "dot-assethub:3", unsubscribed: true }]);
    expect(chain.probes).toEqual([]);
  });

  it("the deposit watch pauses while hidden and stops when the request leaves the screen", async () => {
    const requests = useRequestsStore();
    await requests.create(AWAITING_REF, {
      ...migrated(awaitingDepositCryptoRecord),
      handoff: AWAITING_HANDOFF,
    });
    requests.setForeground(AWAITING_REF);
    await nextTick();
    await settled();
    expect(watchers()).toEqual([{ key: "dot-assethub:3", unsubscribed: false }]);

    // Hidden: the subscription is let go. Visible again: a new one.
    requests.pausePolls();
    expect(watchers()).toEqual([{ key: "dot-assethub:3", unsubscribed: true }]);
    requests.resumePolls();
    await settled();
    expect(watchers()).toEqual([
      { key: "dot-assethub:3", unsubscribed: true },
      { key: "dot-assethub:3", unsubscribed: false },
    ]);

    // The request leaves the screen: the subscription ends and no other takes its place.
    requests.leave();
    await nextTick();
    await settled();
    expect(watchers()).toEqual([
      { key: "dot-assethub:3", unsubscribed: true },
      { key: "dot-assethub:3", unsubscribed: true },
    ]);
    expect(console.warn).not.toHaveBeenCalled();

    // Back on screen, the chain client fails the subscription: one warning, the watch let go
    // until the next sync.
    requests.setForeground(AWAITING_REF);
    await nextTick();
    await settled();
    expect(chain.watchers).toHaveLength(3);
    chain.watchers[2]!.onError(new Error("asset hub unreachable"));
    expect(chain.watchers[2]!.unsubscribed).toBe(true);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      "[requests] deposit watch for dot-assethub#3 failed: asset hub unreachable",
    );
    await settled();
    expect(chain.watchers).toHaveLength(3);
    expect(requests.get(AWAITING_REF)).toMatchObject({
      rev: 0,
      status: { kind: "awaiting-deposit" },
    });
  });
});
