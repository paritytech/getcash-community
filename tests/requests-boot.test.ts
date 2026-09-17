// Boot and lifecycle: the list paints from the mirror before any host read, the skeleton lifts
// once the host records are read, a long background stint resets what counts as confirmed, and
// hiding the page lands what is pending.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { migrateRecord } from "../app/funding/requests/migrate";
import {
  CONFIRMED_TTL_MS,
  HIDDEN_RESET_MS,
  setRequestsClock,
  type RequestRecord,
  type WorkerJobView,
} from "../app/funding/requests/model";
import {
  createMemoryKeyedStorage,
  MIRROR_KEY,
  REQUEST_INDEX_KEY,
  requestKey,
  setMirrorStorage,
  setRecordStorage,
  WORKER_JOBS_KEY,
  type KeyedStorage,
  type WebStorageLike,
} from "../app/funding/requests/storage";
import { useRequestsStore, type DocumentLike, type WindowLike } from "../app/stores/requests";
import type { ActiveFlowRecord } from "../app/stores/session";
import {
  requestRefKey,
  requestRefOf,
  serializeRequestIndex,
  type RequestRef,
} from "../app/utils/request-index";
import { evictChains } from "../lib/host-chain";
import {
  failedCryptoRecord,
  FIXTURE_NOW,
  fixtureRecords,
  fixtureWorkerJobs,
  fundedCryptoRecord,
  settledCardRecord,
  type WorkerJobRecord,
} from "./fixtures/requests";

// The return path runs hosted only. Outside the Polkadot App the chain, the worker and the chain
// clients are stand-ins: empty burners, a worker that is always up, an eviction that only counts.
const { manager } = vi.hoisted(() => ({
  manager: { isAvailable: () => true, call: async () => {}, dispose() {} },
}));
vi.mock("../lib/host-account", () => ({ isHosted: () => true }));
vi.mock("../lib/worker-rpc", () => ({ getStorageWorkerManager: () => manager }));
vi.mock("../lib/coinage-live", () => ({
  probeTradeBurner: async () => ({ address: "", free: 0n }),
  readHostedTradeCounter: async () => 1,
  readFlowSlot: async () => ({ address: "", slot: null }),
  lostRequestHandoff: () => {
    throw new Error("no request is lost in these tests");
  },
}));
vi.mock("../lib/host-chain", () => ({ evictChains: vi.fn() }));

const MINUTE = 60_000;

/** The ref a fixture is stored under: its own source id and trade number. */
const refOf = (record: ActiveFlowRecord): RequestRef =>
  requestRefOf(record.sourceId, record.tradeN!);

const migrated = (record: ActiveFlowRecord): RequestRecord => {
  const result = migrateRecord(record, refOf(record), FIXTURE_NOW);
  if (result === null) throw new Error("fixture did not migrate");
  return result;
};

/** The job as the store reads it out of the worker's blob. */
const viewOf = (job: WorkerJobRecord): WorkerJobView => ({
  phase: job.phase,
  done: job.done,
  ...(job.failure === undefined ? {} : { failure: job.failure }),
  fundsSeenAt: job.state.fundsSeenAt,
  lastTickAt: job.lastTickAt,
  claim:
    job.claim === undefined
      ? null
      : { phase: job.claim.phase, amount: job.claim.amount, at: job.claim.at },
  txs: job.txs,
});

function fakeWebStorage(): WebStorageLike & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

/** A memory record storage that counts the reads and writes under each key, and can hold one
 *  key's reads back until released. */
function countingStorage() {
  const inner = createMemoryKeyedStorage();
  const reads = new Map<string, number>();
  const writes = new Map<string, number>();
  const held = new Map<string, Promise<void>>();
  const storage: KeyedStorage = {
    read: async (key) => {
      reads.set(key, (reads.get(key) ?? 0) + 1);
      await held.get(key);
      return inner.read(key);
    },
    write: (key, value) => {
      writes.set(key, (writes.get(key) ?? 0) + 1);
      return inner.write(key, value);
    },
    clear: (key) => inner.clear(key),
  };
  /** Every read of `key` waits until the returned function is called. */
  function hold(key: string): () => void {
    let release: () => void = () => {};
    held.set(
      key,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return () => {
      held.delete(key);
      release();
    };
  }
  const sum = (counts: Map<string, number>) => [...counts.values()].reduce((a, b) => a + b, 0);
  return {
    storage,
    hold,
    readsOf: (key: string) => reads.get(key) ?? 0,
    totalReads: () => sum(reads),
    writesTo: (key: string) => writes.get(key) ?? 0,
    totalWrites: () => sum(writes),
  };
}

type VisibilityListener = () => void;
type PageListener = (event: { persisted?: boolean }) => void;

/** A `document` whose visibility the test sets and whose events it fires. */
function fakeDocument(): DocumentLike & {
  listeners: Map<string, VisibilityListener[]>;
  dispatch(type: "visibilitychange"): void;
} {
  const listeners = new Map<string, VisibilityListener[]>();
  return {
    visibilityState: "visible",
    listeners,
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener(type, listener) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((l) => l !== listener),
      );
    },
    dispatch(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
  };
}

/** A `window` whose page transition events the test fires. */
function fakeWindow(): WindowLike & {
  listeners: Map<string, PageListener[]>;
  dispatch(type: "pagehide" | "pageshow", event: { persisted?: boolean }): void;
} {
  const listeners = new Map<string, PageListener[]>();
  return {
    listeners,
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener(type, listener) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((l) => l !== listener),
      );
    },
    dispatch(type, event) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
  };
}

function hide(doc: ReturnType<typeof fakeDocument>): void {
  doc.visibilityState = "hidden";
  doc.dispatch("visibilitychange");
}
function show(doc: ReturnType<typeof fakeDocument>): void {
  doc.visibilityState = "visible";
  doc.dispatch("visibilitychange");
}

const realSetTimeout = setTimeout;
/** Yields to the real event loop until `predicate` holds, bounded; the fake clock does not cover
 *  the store's dynamic imports and the storage's promises. */
async function until(predicate: () => boolean): Promise<void> {
  for (let turns = 0; turns < 200 && !predicate(); turns++) {
    await new Promise((resolve) => realSetTimeout(resolve, 0));
  }
}

let host: ReturnType<typeof countingStorage>;
let mirror: ReturnType<typeof fakeWebStorage>;
/** The store's clock; the tests move it. */
let now: number;

/** Stores the records as today's writers do, lists them in the index, and stores the worker's
 *  blob when given one. */
async function seed(
  records: readonly ActiveFlowRecord[],
  jobs?: Record<string, WorkerJobRecord>,
): Promise<void> {
  for (const record of records) {
    await host.storage.write(requestKey(refOf(record)), JSON.stringify(record));
  }
  await host.storage.write(REQUEST_INDEX_KEY, serializeRequestIndex(records.map(refOf)));
  if (jobs !== undefined) await host.storage.write(WORKER_JOBS_KEY, JSON.stringify(jobs));
}

async function stored(ref: RequestRef): Promise<Record<string, unknown> | null> {
  const raw = await host.storage.read(requestKey(ref));
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

const FUNDED_REF = refOf(fundedCryptoRecord);
const FUNDED_KEY = requestRefKey(FUNDED_REF);
const SETTLED_REF = refOf(settledCardRecord);
const SETTLED_KEY = requestRefKey(SETTLED_REF);
const FUNDED_JOB = fixtureWorkerJobs["dot-assethub:4"]!;
const SETTLED_JOB = fixtureWorkerJobs["meld-card:1"]!;

describe("requests store: boot and lifecycle", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    host = countingStorage();
    setRecordStorage(host.storage);
    mirror = fakeWebStorage();
    setMirrorStorage(mirror);
    now = FIXTURE_NOW;
    setRequestsClock(() => now);
    vi.mocked(evictChains).mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    // Neither a poll, the second hand nor a coalesced write may outlive its test.
    const requests = useRequestsStore();
    requests.leave();
    requests.stopJobPoll();
    requests.pausePolls();
    await requests.flush();
    vi.useRealTimers();
    vi.restoreAllMocks();
    setRequestsClock(Date.now);
    setMirrorStorage(null);
  });

  it("hydrates from the mirror before any host read and marks entries cached", () => {
    const records = Object.fromEntries(
      fixtureRecords.map((record) => [requestRefKey(refOf(record)), migrated(record)]),
    );
    mirror.entries.set(
      MIRROR_KEY,
      JSON.stringify({
        schema: 2,
        writtenAt: FIXTURE_NOW - MINUTE,
        index: fixtureRecords.map(refOf),
        records,
      }),
    );
    const requests = useRequestsStore();
    requests.hydrateFromMirror();

    expect(requests.hydrated).toBe(true);
    expect(requests.hostReadDone).toBe(false);
    expect(host.totalReads()).toBe(0);
    expect(host.totalWrites()).toBe(0);
    expect(requests.freshness).toEqual({
      "dot-assethub#4": "cached",
      "dot-assethub#3": "cached",
      "meld-card#2": "cached",
      "dot-assethub#2": "cached",
      "meld-card#1": "cached",
      "dot-assethub#1": "cached",
      "#7": "cached",
    });
  });

  it("hostReadDone flips topUpsReady without the permission front-load", async () => {
    await seed([settledCardRecord, failedCryptoRecord]);
    const releaseJobs = host.hold(WORKER_JOBS_KEY);
    const requests = useRequestsStore();

    let landed = false;
    const reconcile = requests.reconcile("boot").then(() => {
      landed = true;
    });
    await until(() => requests.hostReadDone);

    // The records are read and on screen while the worker step still waits for its blob.
    expect(requests.hostReadDone).toBe(true);
    expect(requests.hydrated).toBe(false);
    expect(landed).toBe(false);
    expect(requests.reconcilingNow).toBe(true);
    expect(Object.keys(requests.entries).sort()).toEqual(["dot-assethub#2", "meld-card#1"]);
    expect(host.readsOf(WORKER_JOBS_KEY)).toBe(1);

    releaseJobs();
    await reconcile;
    expect(landed).toBe(true);
    expect(requests.reconcilingNow).toBe(false);
  });

  it("visible after a long hide resets the epoch and reconciles; a short hide does not", async () => {
    await seed([fundedCryptoRecord], { "dot-assethub:4": FUNDED_JOB });
    const requests = useRequestsStore();
    await requests.reconcile("boot");
    expect(requests.get(FUNDED_REF)?.confirmedAt).toBe(FIXTURE_NOW);
    expect(requests.freshness).toEqual({ [FUNDED_KEY]: "confirmed" });
    const indexReadsAtBoot = host.readsOf(REQUEST_INDEX_KEY);

    const doc = fakeDocument();
    const win = fakeWindow();
    const detach = requests.attachLifecycle({ document: doc, window: win });

    // A quick app switch: nothing is reread.
    hide(doc);
    now += 2_000;
    show(doc);
    expect(requests.sessionEpoch).toBe(FIXTURE_NOW);
    expect(requests.reconcilingNow).toBe(false);
    expect(host.readsOf(REQUEST_INDEX_KEY)).toBe(indexReadsAtBoot);
    expect(requests.freshness).toEqual({ [FUNDED_KEY]: "confirmed" });
    expect(evictChains).not.toHaveBeenCalled();

    // A real background stint: every row waits on the pass that follows.
    hide(doc);
    now += HIDDEN_RESET_MS + 1_000;
    show(doc);
    const returnedAt = now;
    expect(requests.sessionEpoch).toBe(returnedAt);
    expect(requests.reconcilingNow).toBe(true);
    expect(requests.freshness).toEqual({ [FUNDED_KEY]: "reconciling" });

    await until(() => !requests.reconcilingNow);
    expect(requests.reconcilingNow).toBe(false);
    expect(host.readsOf(REQUEST_INDEX_KEY)).toBe(indexReadsAtBoot + 1);
    expect(evictChains).toHaveBeenCalledTimes(1);
    expect(requests.get(FUNDED_REF)?.confirmedAt).toBe(returnedAt);
    expect(requests.freshness).toEqual({ [FUNDED_KEY]: "confirmed" });

    detach();
    expect(doc.listeners.get("visibilitychange")).toEqual([]);
    expect(win.listeners.get("pagehide")).toEqual([]);
    expect(win.listeners.get("pageshow")).toEqual([]);
    hide(doc);
    now += HIDDEN_RESET_MS + 1_000;
    show(doc);
    expect(requests.sessionEpoch).toBe(returnedAt);
    expect(requests.reconcilingNow).toBe(false);
    expect(host.readsOf(REQUEST_INDEX_KEY)).toBe(indexReadsAtBoot + 1);
    expect(evictChains).toHaveBeenCalledTimes(1);
  });

  it("hidden and pagehide flush pending writes", async () => {
    vi.useFakeTimers();
    const requests = useRequestsStore();
    await requests.create(FUNDED_REF, migrated(fundedCryptoRecord));
    const key = requestKey(FUNDED_REF);
    expect(host.writesTo(key)).toBe(1);
    const doc = fakeDocument();
    const win = fakeWindow();
    requests.attachLifecycle({ document: doc, window: win });

    // Two notes inside one coalescing window: nothing has reached the host.
    await requests.flag(FUNDED_REF, "first note");
    await requests.flag(FUNDED_REF, "second note");
    expect(requests.get(FUNDED_REF)?.rev).toBe(2);
    expect(host.writesTo(key)).toBe(1);

    hide(doc);
    await until(() => host.writesTo(key) === 2);
    expect(host.writesTo(key)).toBe(2);
    expect(await stored(FUNDED_REF)).toMatchObject({
      rev: 2,
      witnesses: { conflict: { source: "core", note: "second note", at: FIXTURE_NOW } },
    });

    show(doc);
    await requests.flag(FUNDED_REF, "third note");
    expect(host.writesTo(key)).toBe(2);

    win.dispatch("pagehide", {});
    await until(() => host.writesTo(key) === 3);
    expect(host.writesTo(key)).toBe(3);
    expect(await stored(FUNDED_REF)).toMatchObject({
      rev: 3,
      witnesses: { conflict: { source: "core", note: "third note", at: FIXTURE_NOW } },
    });
  });

  it("confirmed decays after the TTL for open entries and not for settled", async () => {
    vi.useFakeTimers();
    const requests = useRequestsStore();
    await requests.create(FUNDED_REF, migrated(fundedCryptoRecord));
    await requests.create(SETTLED_REF, migrated(settledCardRecord));
    await requests.observe(FUNDED_REF, { source: "worker", at: now, job: viewOf(FUNDED_JOB) });
    await requests.observe(SETTLED_REF, { source: "worker", at: now, job: viewOf(SETTLED_JOB) });
    expect(requests.get(FUNDED_REF)?.status.kind).toBe("converting");
    expect(requests.get(SETTLED_REF)?.status.kind).toBe("settled");
    expect(requests.get(FUNDED_REF)?.confirmedAt).toBe(FIXTURE_NOW);
    expect(requests.get(SETTLED_REF)?.confirmedAt).toBe(FIXTURE_NOW);
    expect(requests.tick).toBe(FIXTURE_NOW);
    expect(requests.freshness).toEqual({ [FUNDED_KEY]: "confirmed", [SETTLED_KEY]: "confirmed" });

    now = FIXTURE_NOW + CONFIRMED_TTL_MS + 1_000;
    vi.advanceTimersByTime(CONFIRMED_TTL_MS + 1_000);
    expect(requests.tick).toBe(now);
    expect(requests.freshness).toEqual({ [FUNDED_KEY]: "cached", [SETTLED_KEY]: "confirmed" });
  });
});
