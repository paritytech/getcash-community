// The cleanups the single source made possible: one deposit deadline shared with core, a trade
// number never reused, no burner backup, a submitted card payment that never expires, and an open
// that never waits for a reconcile.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { depositWindowFor } from "../app/funding/config";
import { migrateRecord } from "../app/funding/requests/migrate";
import {
  setRequestsClock,
  type Observation,
  type RequestRecord,
} from "../app/funding/requests/model";
import { reduce } from "../app/funding/requests/reducer";
import {
  createMemoryKeyedStorage,
  REQUEST_INDEX_KEY,
  requestKey,
  setMirrorStorage,
  setRecordStorage,
  WORKER_JOBS_KEY,
  type KeyedStorage,
  type WebStorageLike,
} from "../app/funding/requests/storage";
import { useRequestsStore } from "../app/stores/requests";
import { useSessionStore, type ActiveFlowRecord } from "../app/stores/session";
import { requestRefOf, serializeRequestIndex, type RequestRef } from "../app/utils/request-index";
import { nextFreeTradeNumber, tradeCounterKey } from "../lib/coinage";
import { awaitingDepositCryptoRecord, FIXTURE_NOW, submittedCardRecord } from "./fixtures/requests";

// Outside the Polkadot App the hosted world is a stand-in that records what it was built with
// and answers with the flow slot the test gives it; a quote's trade number comes from a stand-in
// too.
const { worlds, hosted, slot, RESERVED_TRADE_N } = vi.hoisted(() => ({
  worlds: [] as { tradeN?: number; sourceId?: string; staleFlowMs?: number }[],
  hosted: { value: false },
  slot: { value: null as { phase: string } | null },
  RESERVED_TRADE_N: 9,
}));
vi.mock("../lib/host-account", () => ({ isHosted: () => hosted.value }));
vi.mock("../lib/coinage-live", () => ({
  DEFAULT_SOURCE_ID: "dot-assethub",
  nextHostedTradeNumber: async () => RESERVED_TRADE_N,
  createHostedCoinageWorld: async (args: {
    tradeN?: number;
    sourceId?: string;
    staleFlowMs?: number;
  }) => {
    worlds.push(args);
    return {
      session: {
        ready: Promise.resolve(),
        peek: () => slot.value,
        getState: () => ({ phase: slot.value?.phase ?? "idle" }),
        subscribe: () => ({ unsubscribe() {} }),
        resume: async () => {},
        quote: async () => ({ source: { formatted: "1", assetSymbol: "DOT", amount: 10n } }),
        dispose() {},
      },
      sourceId: args.sourceId ?? "dot-assethub",
      tradeN: args.tradeN ?? 1,
      refundAddress: null,
      revealRefundKey: () => null,
      runFunding: async () => {},
      dispose() {},
    };
  },
}));

const HOUR = 60 * 60_000;
const SOURCE = "dot-assethub";
const NO_FREE_NUMBER = `no free trade number for ${SOURCE} within 100 of the counter`;

/** The ref a fixture is stored under: its own source id and trade number. */
const refOf = (record: ActiveFlowRecord): RequestRef =>
  requestRefOf(record.sourceId, record.tradeN!);

const migrated = (record: ActiveFlowRecord): RequestRecord => {
  const result = migrateRecord(record, refOf(record), FIXTURE_NOW);
  if (result === null) throw new Error("fixture did not migrate");
  return result;
};

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

/** A record storage whose reads of `heldKey` never answer. */
function holdingStorage(heldKey: string): KeyedStorage {
  const inner = createMemoryKeyedStorage();
  return {
    read: (key) => (key === heldKey ? new Promise<string | null>(() => {}) : inner.read(key)),
    write: (key, value) => inner.write(key, value),
    clear: (key) => inner.clear(key),
  };
}

/** Yields to the event loop until `predicate` holds, at most `turns` times. */
async function settle(predicate: () => boolean, turns = 20): Promise<void> {
  for (let turn = 0; turn < turns && !predicate(); turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** True when `promise` has settled by the next microtask. */
const settled = (promise: Promise<unknown>): Promise<boolean> =>
  Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    Promise.resolve(false),
  ]);

/** A trade counter store: the one key `nextFreeTradeNumber` reads and writes. */
function counterStorage(counter?: number) {
  const entries = new Map<string, string>();
  if (counter !== undefined) entries.set(tradeCounterKey(SOURCE), String(counter));
  return {
    read: async (key: string) => entries.get(key) ?? null,
    write: async (key: string, value: string) => {
      entries.set(key, value);
    },
    counter: () => entries.get(tradeCounterKey(SOURCE)) ?? null,
  };
}

/** The clock at `at`. */
const clock = (at: number): Observation => ({ source: "clock", at });
/** The worker gave up waiting for the deposit at `at`. */
const workerExpired = (at: number): Observation => ({
  source: "worker",
  at,
  job: {
    phase: "failed",
    done: false,
    failure: "expired",
    fundsSeenAt: null,
    lastTickAt: at,
    claim: null,
  },
});

describe("requests cleanups", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setRecordStorage(createMemoryKeyedStorage());
    setMirrorStorage(fakeWebStorage());
    setRequestsClock(() => FIXTURE_NOW);
    worlds.length = 0;
    hosted.value = false;
    slot.value = null;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(async () => {
    const requests = useRequestsStore();
    requests.stopJobPoll();
    await requests.flush();
    vi.restoreAllMocks();
    setRequestsClock(Date.now);
    setMirrorStorage(null);
  });

  it("passes the route window to core as staleFlowMs", async () => {
    // Both halves are the hosted path: off-host a re-open builds a mock world instead, and a
    // quote never reaches core's hosted one.
    hosted.value = true;
    // A re-open: the record's own window, here the rail's six hours.
    const record: ActiveFlowRecord = {
      ...awaitingDepositCryptoRecord,
      depositExpiresAt: awaitingDepositCryptoRecord.startedAt + 6 * HOUR,
    };
    const ref = refOf(record);
    const storage = createMemoryKeyedStorage();
    setRecordStorage(storage);
    await storage.write(requestKey(ref), JSON.stringify(record));
    await storage.write(REQUEST_INDEX_KEY, serializeRequestIndex([ref]));
    const session = useSessionStore();
    await session.openRequest(ref);
    expect(worlds).toHaveLength(1);
    expect(worlds[0]).toMatchObject({ tradeN: 3, sourceId: SOURCE, staleFlowMs: 6 * HOUR });

    // A fresh hosted quote: the route's window, under the number the quote reserved.
    session.setAmount("1");
    await session.fetchQuote("Nowhere", "X");
    expect(session.quoteError).toBeNull();
    expect(worlds).toHaveLength(2);
    expect(worlds[1]).toMatchObject({
      tradeN: RESERVED_TRADE_N,
      staleFlowMs: depositWindowFor("crypto"),
    });
    expect(depositWindowFor("crypto")).toBe(86_400_000);
  });

  it("nextFreeTradeNumber skips numbers with a record, a slot or a job and persists the counter", async () => {
    const taken = counterStorage(4);
    const hasTrace = vi.fn(async (n: number) => n === 4 || n === 5);
    expect(await nextFreeTradeNumber(taken, SOURCE, hasTrace)).toBe(6);
    expect(taken.counter()).toBe("6");
    expect(hasTrace.mock.calls.map(([n]) => n)).toEqual([4, 5, 6]);
    expect(console.warn).toHaveBeenCalledTimes(1);

    const free = counterStorage(4);
    expect(await nextFreeTradeNumber(free, SOURCE, async () => false)).toBe(4);
    expect(free.counter()).toBe("4");
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("start no longer writes the burner backup", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../lib/coinage.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toContain("coinage:burner:");
    // The counter advance moved to the session store's start(); the session itself no longer
    // watches for the request to start.
    const start = source.indexOf("export async function createCoinageSession(");
    expect(start).toBeGreaterThan(0);
    expect(source.slice(start)).not.toContain("session.subscribe(");
  });

  it("bounded search throws after 100 numbers", async () => {
    const storage = counterStorage(4);
    const hasTrace = vi.fn(async () => true);
    await expect(nextFreeTradeNumber(storage, SOURCE, hasTrace)).rejects.toThrow(NO_FREE_NUMBER);
    expect(hasTrace).toHaveBeenCalledTimes(100);
    expect(storage.counter()).toBe("4");
  });

  it("opening a request does not wait for the reconcile", async () => {
    hosted.value = true;
    slot.value = { phase: "awaiting-deposit" };
    const ref = refOf(awaitingDepositCryptoRecord);
    const storage = holdingStorage(WORKER_JOBS_KEY);
    setRecordStorage(storage);
    await storage.write(requestKey(ref), JSON.stringify(awaitingDepositCryptoRecord));
    await storage.write(REQUEST_INDEX_KEY, serializeRequestIndex([ref]));
    const requests = useRequestsStore();
    const session = useSessionStore();

    // The boot pass reads the record, then blocks on the worker's blob for good.
    const reconcile = requests.reconcile("boot");
    await settle(() => requests.has(ref));
    expect(requests.has(ref)).toBe(true);
    expect(await settled(reconcile)).toBe(false);

    expect(await session.openRequest(ref)).toBe(true);
    expect(requests.foregroundRecord?.ref).toEqual(ref);
    expect(worlds).toHaveLength(1);
    expect(worlds[0]).toMatchObject({ tradeN: 3, sourceId: SOURCE });
    expect(await settled(reconcile)).toBe(false);
  });

  it("a submitted card payment never expires", () => {
    const submitted = migrated(submittedCardRecord);
    expect(submitted.meldSubmittedAt).toBeDefined();
    expect(submitted.rail.stage).toBe("waiting");
    expect(submitted.status).toEqual({ kind: "awaiting-deposit" });
    const deadline = submitted.deadline.depositExpiresAt!;
    const late = deadline + 1;

    expect(reduce(submitted, clock(late)).status).toEqual({ kind: "awaiting-deposit" });
    expect(reduce(submitted, workerExpired(late)).status).toEqual({ kind: "awaiting-deposit" });

    const { meldSubmittedAt: _stamp, ...unsubmitted } = submitted;
    expect(reduce(unsubmitted, clock(late)).status).toEqual({ kind: "expired", at: late });
    expect(reduce(unsubmitted, workerExpired(late)).status).toEqual({ kind: "expired", at: late });
  });
});
