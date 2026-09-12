// The requests store: every request record in one map, moved only by the reducer, mirrored to
// Web Storage on every change and persisted to the host store beneath. Today's list and statuses
// are views over it.

import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import {
  advanceFundingProgressSnapshot,
  type FundingProgressSignal,
  type FundingProgressSnapshot,
} from "../funding/progress";
import { migrateRecord } from "../funding/requests/migrate";
import {
  COALESCE_MS,
  MIRROR_SETTLED_LIMIT,
  rankOf,
  requestsNow,
  type Observation,
  type RequestKey,
  type RequestRecord,
} from "../funding/requests/model";
import { reduce } from "../funding/requests/reducer";
import {
  getRecordStorage,
  readMirrorSync,
  REQUEST_INDEX_KEY,
  requestKey,
  writeMirrorSync,
  type KeyedStorage,
} from "../funding/requests/storage";
import { legacyRequestStatus } from "../funding/requests/views";
import {
  parseRequestIndex,
  parseRequestRefKey,
  requestRefKey,
  sameRequestRef,
  serializeRequestIndex,
  type RequestRef,
} from "../utils/request-index";
import type { ActiveFlowRecord, RequestStatus as LegacyRequestStatus } from "./session";

export interface RequestEntry {
  record: RequestRecord;
  /** The last host write's failure; cleared by the next successful write. */
  persistError?: string;
  /** The last host read's failure; cleared by the next successful read. */
  readError?: string;
  /** The memory record is ahead of the host store. */
  pendingWrite: boolean;
}

/** A list row: today's `ActiveFlowRecord` shape, its progress resolved. */
export type RequestListRow = ActiveFlowRecord & { progress: FundingProgressSnapshot };

/** How many records a reconcile reads at once. */
const READ_PARALLELISM = 4;

/** The status kinds whose arrival is written to the host before `observe` resolves. */
const CRITICAL_KINDS = new Set<RequestRecord["status"]["kind"]>([
  "deposit-seen",
  "settled",
  "cancelled",
  "failed",
  "expired",
]);

/** A critical change is written to the host before `observe` resolves: the deposit's first
 *  sighting (a worker step can carry a record from awaiting-deposit straight to converting), a
 *  terminal or side-exit kind, the buyer's submit, a failure. */
function isCritical(previous: RequestRecord, next: RequestRecord): boolean {
  return (
    (rankOf(previous) === 0 && rankOf(next) >= 1) ||
    (next.status.kind !== previous.status.kind && CRITICAL_KINDS.has(next.status.kind)) ||
    (previous.meldSubmittedAt === undefined && next.meldSubmittedAt !== undefined) ||
    (previous.failure === undefined && next.failure !== undefined)
  );
}

interface Mirror {
  schema: 2;
  writtenAt: number;
  index: RequestRef[];
  records: Record<RequestKey, unknown>;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Newest first; the trade number breaks ties. Today's `readAllRequests` order. */
const newestFirst = (a: RequestRecord, b: RequestRecord): number =>
  b.startedAt - a.startedAt || (b.tradeN ?? b.ref.tradeN) - (a.tradeN ?? a.ref.tradeN);

const settledAtOf = (record: RequestRecord): number =>
  record.status.kind === "settled" ? record.status.at : 0;

/** Today's normalisation: the ref is the identity, so the record's own source id is dropped and
 *  the ref's is set when it has one. */
function listRow(record: RequestRecord): RequestListRow {
  const { sourceId: _own, ...rest } = record;
  const { ref } = record;
  return {
    ...rest,
    tradeN: record.tradeN ?? ref.tradeN,
    ...(ref.sourceId === undefined ? {} : { sourceId: ref.sourceId }),
  };
}

function parseMirror(raw: string): Mirror | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { schema, records } = parsed as Partial<Mirror>;
  if (schema !== 2 || typeof records !== "object" || records === null) return null;
  return parsed as Mirror;
}

/** Runs `work` over `items` with at most `limit` in flight. */
async function inParallel<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

export const useRequestsStore = defineStore("requests", () => {
  const entries = shallowRef<Readonly<Record<RequestKey, RequestEntry>>>({});
  /** A mirror with today's schema was read into memory. */
  const hydrated = ref(false);
  /** The first reconcile has finished, whatever it found. */
  const hostReadDone = ref(false);
  const storage = ref<"ok" | "unavailable">("ok");

  const records = computed(() => Object.values(entries.value).map((entry) => entry.record));
  const open = computed(() => records.value.filter((record) => record.status.kind !== "cancelled"));
  const list = computed<RequestListRow[]>(() => [...open.value].sort(newestFirst).map(listRow));
  const statuses = computed<Record<RequestKey, LegacyRequestStatus>>(() => {
    const out: Record<RequestKey, LegacyRequestStatus> = {};
    for (const record of open.value) {
      const status = legacyRequestStatus(record);
      if (status !== undefined) out[requestRefKey(record.ref)] = status;
    }
    return out;
  });

  const get = (ref: RequestRef): RequestRecord | undefined =>
    entries.value[requestRefKey(ref)]?.record;
  const has = (ref: RequestRef): boolean => entries.value[requestRefKey(ref)] !== undefined;

  function setEntry(key: RequestKey, entry: RequestEntry): void {
    entries.value = { ...entries.value, [key]: entry };
  }
  function patchEntry(key: RequestKey, patch: (entry: RequestEntry) => RequestEntry): void {
    const entry = entries.value[key];
    if (entry !== undefined) setEntry(key, patch(entry));
  }
  function dropEntry(key: RequestKey): void {
    const { [key]: _gone, ...rest } = entries.value;
    entries.value = rest;
  }

  // One serial queue per key: reads, observations and writes of a record never interleave.
  const queues = new Map<RequestKey, Promise<unknown>>();
  function enqueue<T>(key: RequestKey, task: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    // A failed predecessor never blocks the queue.
    const run = previous.catch(() => undefined).then(task);
    queues.set(key, run);
    void run
      .finally(() => {
        if (queues.get(key) === run) queues.delete(key);
      })
      .catch(() => undefined);
    return run;
  }

  /** The open records plus the most recently settled, as one synchronous blob. */
  function writeMirror(): void {
    const all = records.value;
    const kept: Record<RequestKey, RequestRecord> = {};
    for (const record of all) {
      if (record.status.kind !== "settled") kept[requestRefKey(record.ref)] = record;
    }
    const settled = all
      .filter((record) => record.status.kind === "settled")
      .sort((a, b) => settledAtOf(b) - settledAtOf(a))
      .slice(0, MIRROR_SETTLED_LIMIT);
    for (const record of settled) kept[requestRefKey(record.ref)] = record;
    const mirror: Mirror = {
      schema: 2,
      writtenAt: requestsNow(),
      index: all.map((record) => record.ref),
      records: kept,
    };
    writeMirrorSync(JSON.stringify(mirror));
  }

  /** Reads the mirror into memory without touching an entry already there. */
  function hydrateFromMirror(): void {
    const raw = readMirrorSync();
    if (raw === null) return;
    const mirror = parseMirror(raw);
    if (mirror === null) return;
    const now = requestsNow();
    const next: Record<RequestKey, RequestEntry> = { ...entries.value };
    for (const [key, stored] of Object.entries(mirror.records)) {
      if (next[key] !== undefined) continue;
      const ref = parseRequestRefKey(key);
      if (ref === null) continue;
      const record = migrateRecord(stored, ref, now);
      if (record !== null) next[key] = { record, pendingWrite: false };
    }
    entries.value = next;
    hydrated.value = true;
  }

  /** Writes the entry's record to the host store. False when the write failed: the entry then
   *  carries `persistError` and stays pending for the next observation or reconcile. */
  async function writeHost(key: RequestKey): Promise<boolean> {
    const entry = entries.value[key];
    if (entry === undefined || !entry.pendingWrite) return true;
    const { record } = entry;
    try {
      const store = await getRecordStorage();
      await store.write(requestKey(record.ref), JSON.stringify(record));
    } catch (e) {
      const persistError = messageOf(e);
      patchEntry(key, (current) => ({ ...current, persistError }));
      console.warn(`[requests] record write failed for ${key}: ${persistError}`);
      return false;
    }
    patchEntry(key, (current) => {
      const { persistError: _cleared, ...written } = current;
      // A change that landed during the write keeps its own pending write.
      return written.record === record ? { ...written, pendingWrite: false } : written;
    });
    return true;
  }

  // Non-critical changes reach the host after a trailing window per key; a critical one at once.
  const coalesced = new Map<RequestKey, ReturnType<typeof setTimeout>>();
  function cancelCoalesced(key: RequestKey): void {
    const timer = coalesced.get(key);
    if (timer !== undefined) clearTimeout(timer);
    coalesced.delete(key);
  }
  function scheduleWrite(key: RequestKey): void {
    cancelCoalesced(key);
    coalesced.set(
      key,
      setTimeout(() => {
        coalesced.delete(key);
        void enqueue(key, () => writeHost(key));
      }, COALESCE_MS),
    );
  }
  /** Fires every pending coalesced write now. */
  function flush(): Promise<void> {
    const keys = [...coalesced.keys()];
    for (const key of keys) cancelCoalesced(key);
    return Promise.all(keys.map((key) => enqueue(key, () => writeHost(key)))).then(() => {});
  }

  /** Replaces the entry's record: the mirror at once, the host now when the change is critical
   *  and after the coalescing window otherwise. Runs inside the key's queue. */
  async function commit(key: RequestKey, next: RequestRecord, critical: boolean): Promise<void> {
    patchEntry(key, (entry) => ({ ...entry, record: next, pendingWrite: true }));
    writeMirror();
    if (critical) {
      cancelCoalesced(key);
      await writeHost(key);
    } else {
      scheduleWrite(key);
    }
  }

  /** Adds a new record: memory and the mirror at once, then the host record and the index entry,
   *  both awaited. Throws when the key already has a record. */
  async function create(ref: RequestRef, record: RequestRecord): Promise<void> {
    const key = requestRefKey(ref);
    if (entries.value[key] !== undefined) throw new Error(`request ${key} already has a record`);
    setEntry(key, { record, pendingWrite: true });
    writeMirror();
    await enqueue(key, async () => {
      if (!(await writeHost(key))) {
        throw new Error(entries.value[key]?.persistError ?? "record write failed");
      }
      await mutateIndex((current) => [...current, ref]);
    });
  }

  /** Moves a record by one observation. A key with no record is left alone. */
  function observe(ref: RequestRef, observation: Observation): Promise<void> {
    const key = requestRefKey(ref);
    if (entries.value[key] === undefined) return Promise.resolve();
    return enqueue(key, async () => {
      const entry = entries.value[key];
      if (entry === undefined) return;
      const reduced = reduce(entry.record, observation);
      if (reduced === entry.record) return;
      const next = { ...reduced, rev: entry.record.rev + 1 };
      await commit(key, next, isCritical(entry.record, next));
    });
  }

  // Interim path for the core and provider progress signals until milestones 5 and 6 route them
  // as observations.
  function advanceProgress(
    ref: RequestRef,
    signal: FundingProgressSignal,
    at: number,
    markFunded = false,
  ): Promise<void> {
    const key = requestRefKey(ref);
    if (entries.value[key] === undefined) return Promise.resolve();
    return enqueue(key, async () => {
      const entry = entries.value[key];
      if (entry === undefined) return;
      const { record } = entry;
      const progress = advanceFundingProgressSnapshot(record.progress, { ...signal, at });
      const funded = markFunded && record.funded === undefined ? at : record.funded;
      if (progress === record.progress && funded === record.funded) return;
      const next = {
        ...record,
        rev: record.rev + 1,
        progress,
        ...(funded === undefined ? {} : { funded }),
      };
      await commit(key, next, false);
    });
  }

  /** Notes on the record something no observation carries: the core slot it expects is gone. */
  function flag(ref: RequestRef, note: string): Promise<void> {
    const key = requestRefKey(ref);
    if (entries.value[key] === undefined) return Promise.resolve();
    return enqueue(key, async () => {
      const entry = entries.value[key];
      if (entry === undefined) return;
      const { record } = entry;
      const conflict = { source: "core" as const, note, at: requestsNow() };
      const witnesses = { ...record.witnesses, conflict };
      await commit(key, { ...record, rev: record.rev + 1, witnesses }, false);
    });
  }

  /** Deletes the record from the host store, memory and the index: the tombstone reap's only
   *  deletion. */
  function remove(ref: RequestRef): Promise<void> {
    const key = requestRefKey(ref);
    return enqueue(key, async () => {
      cancelCoalesced(key);
      const store = await getRecordStorage();
      await store.clear(requestKey(ref));
      dropEntry(key);
      writeMirror();
      await mutateIndex((current) => current.filter((r) => !sameRequestRef(r, ref)));
    });
  }

  /** Every index change runs here, one at a time: read, change, write. */
  let indexLock: Promise<unknown> = Promise.resolve();
  function mutateIndex(change: (current: RequestRef[]) => RequestRef[]): Promise<void> {
    const run = async () => {
      const store = await getRecordStorage();
      const current = parseRequestIndex(await store.read(REQUEST_INDEX_KEY));
      await store.write(REQUEST_INDEX_KEY, serializeRequestIndex(change(current)));
    };
    // A failed change must not wedge the chain: the next one runs regardless.
    const next = indexLock.then(run, run);
    indexLock = next.catch(() => {});
    return next;
  }

  let reconciling: Promise<void> | null = null;
  let reconcileAgain = false;
  /** Brings memory up to date with the host store, then lets the clock expire what it must.
   *  Single-flight: a caller arriving mid-run makes it run once more. */
  function reconcile(reason: string): Promise<void> {
    if (reconciling) {
      reconcileAgain = true;
      return reconciling;
    }
    reconciling = (async () => {
      try {
        do {
          reconcileAgain = false;
          await reconcileOnce(reason);
        } while (reconcileAgain);
      } finally {
        reconciling = null;
        hostReadDone.value = true;
      }
    })();
    return reconciling;
  }

  async function reconcileOnce(reason: string): Promise<void> {
    let store: KeyedStorage;
    try {
      store = await getRecordStorage();
    } catch (e) {
      storage.value = "unavailable";
      console.warn(`[requests] reconcile (${reason}): record storage unavailable: ${messageOf(e)}`);
      return;
    }
    storage.value = "ok";
    let indexed: RequestRef[] | null;
    try {
      indexed = parseRequestIndex(await store.read(REQUEST_INDEX_KEY));
    } catch (e) {
      // The memory refs are still read; the index itself is left as it is.
      indexed = null;
      console.warn(`[requests] reconcile (${reason}): index read failed: ${messageOf(e)}`);
    }
    const now = requestsNow();
    let changed = false;

    function noteReadError(key: RequestKey, e: unknown): void {
      const readError = messageOf(e);
      console.warn(`[requests] record read failed for ${key} (kept): ${readError}`);
      patchEntry(key, (current) => ({ ...current, readError }));
    }

    async function readOne(ref: RequestRef): Promise<void> {
      const key = requestRefKey(ref);
      const entry = entries.value[key];
      // Settled is terminal: history costs no read once it is in memory.
      if (entry?.record.status.kind === "settled") {
        if (entry.pendingWrite) scheduleWrite(key);
        return;
      }
      let raw: string | null;
      try {
        raw = await store.read(requestKey(ref));
      } catch (e) {
        noteReadError(key, e);
        return;
      }
      if (raw === null) {
        // The host lost the record, or never got it: memory's copy is written back.
        if (entries.value[key] !== undefined) {
          patchEntry(key, (current) => ({ ...current, pendingWrite: true }));
          scheduleWrite(key);
        }
        return;
      }
      let stored: unknown;
      try {
        stored = JSON.parse(raw);
      } catch (e) {
        noteReadError(key, e);
        return;
      }
      const host = migrateRecord(stored, ref, now);
      if (host === null) return; // unusable, and never pruned
      await enqueue(key, async () => {
        const current = entries.value[key];
        if (current === undefined || host.rev > current.record.rev) {
          setEntry(key, { record: host, pendingWrite: false });
          changed = true;
          return;
        }
        const { readError: _cleared, ...read } = current;
        if (host.rev < current.record.rev) {
          // A write that failed last session: memory is ahead of the host.
          setEntry(key, { ...read, pendingWrite: true });
          scheduleWrite(key);
        } else if (current.readError !== undefined) {
          setEntry(key, read);
        }
      });
    }

    const refs = new Map<RequestKey, RequestRef>();
    for (const ref of indexed ?? []) refs.set(requestRefKey(ref), ref);
    for (const record of records.value) {
      const key = requestRefKey(record.ref);
      if (!refs.has(key)) refs.set(key, record.ref);
    }
    await inParallel([...refs.values()], READ_PARALLELISM, readOne);
    if (changed) writeMirror();

    if (indexed !== null) {
      const listed = new Set(indexed.map(requestRefKey));
      const missing = records.value
        .map((record) => record.ref)
        .filter((ref) => !listed.has(requestRefKey(ref)));
      if (missing.length > 0) {
        await mutateIndex((current) => [...current, ...missing]).catch((e: unknown) => {
          console.warn(`[requests] reconcile (${reason}): index append failed: ${messageOf(e)}`);
        });
      }
    }

    await Promise.all(
      records.value
        .filter((record) => rankOf(record) === 0)
        .map((record) => observe(record.ref, { source: "clock", at: now })),
    );
  }

  hydrateFromMirror();

  return {
    entries,
    records,
    list,
    statuses,
    hydrated,
    hostReadDone,
    storage,
    get,
    has,
    create,
    observe,
    advanceProgress,
    flag,
    remove,
    hydrateFromMirror,
    writeMirror,
    reconcile,
    flush,
  };
});
