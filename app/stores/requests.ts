// The requests store: every request record in one map, moved only by the reducer, mirrored to
// Web Storage on every change and persisted to the host store beneath. The worker's job blob is
// read here and nowhere else. Today's list and statuses are views over it.

import { defineStore } from "pinia";
import { computed, ref, shallowRef, watch } from "vue";
import type { SourceId } from "@getsome/core";
import {
  advanceFundingProgressSnapshot,
  createFundingProgressSnapshot,
  progressProviderForSource,
  type FundingProgressSignal,
  type FundingProgressSnapshot,
} from "../funding/progress";
import { migrateRecord } from "../funding/requests/migrate";
import {
  CANCEL_CONFIRM_MS,
  COALESCE_MS,
  DEFAULT_DEPOSIT_WINDOW_MS,
  JOB_POLL_MS,
  MIRROR_SETTLED_LIMIT,
  effectiveSourceId,
  railProviderOf,
  rankOf,
  requestsNow,
  routeOf,
  type Observation,
  type RequestKey,
  type RequestRecord,
  type WorkerHandoffPayload,
  type WorkerJobView,
} from "../funding/requests/model";
import { reduce } from "../funding/requests/reducer";
import {
  getRecordStorage,
  readMirrorSync,
  REQUEST_INDEX_KEY,
  requestKey,
  WORKER_JOBS_KEY,
  writeMirrorSync,
  type KeyedStorage,
} from "../funding/requests/storage";
import { legacyRequestStatus } from "../funding/requests/views";
import { CRYPTO_SOURCE_ID } from "../funding/source-ids";
import { fmtCash, toCashBase } from "../utils/cash";
import {
  parseRequestIndex,
  parseRequestRefKey,
  requestRefKey,
  requestRefOf,
  sameRequestRef,
  serializeRequestIndex,
  type RequestRef,
} from "../utils/request-index";
import { sendHandoff, workerSessionId } from "~~/lib/coinage";
import { SOURCE_CHAINS, sourceIdFor } from "~~/lib/config";
import { isHosted } from "~~/lib/host-account";
import type { ActiveFlowRecord, RequestStatus as LegacyRequestStatus } from "./session";

export interface RequestEntry {
  record: RequestRecord;
  /** The last host write's failure; cleared by the next successful write. */
  persistError?: string;
  /** The last host read's failure; cleared by the next successful read. */
  readError?: string;
  /** The last hand-off's failure, a send or a build; cleared by the next successful send. */
  handoffError?: string;
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

/** The fields an observation changes without moving the record: per-session facts, never
 *  written on their own. A persisted witness is stale by definition. */
const WITNESS_FIELDS: ReadonlySet<string> = new Set(["witnesses", "confirmedAt", "updatedAt"]);

/** True when `next` differs from `current` in the witness fields alone. The reducer keeps every
 *  field it did not touch as the same object, so a per-field `===` is exact. */
function witnessOnly(current: RequestRecord, next: RequestRecord): boolean {
  const fields = new Set([...Object.keys(current), ...Object.keys(next)]);
  for (const field of fields) {
    if (WITNESS_FIELDS.has(field)) continue;
    if (current[field as keyof RequestRecord] !== next[field as keyof RequestRecord]) return false;
  }
  return true;
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

const MINUTE = 60_000;

/** Rank 0–3 in the design's sense: a request the worker is still moving. */
const WORKER_DRIVEN_KINDS = new Set<RequestRecord["status"]["kind"]>([
  "awaiting-deposit",
  "deposit-seen",
  "converting",
  "claiming",
]);
const isWorkerDriven = (record: RequestRecord): boolean =>
  WORKER_DRIVEN_KINDS.has(record.status.kind);
/** Rank 0–3, or a side exit the worker's verdict can still move: failed or expired. */
const followsWorker = (record: RequestRecord): boolean =>
  isWorkerDriven(record) || record.status.kind === "failed" || record.status.kind === "expired";

/** The rail stages at or past the buyer's payment. */
const PAID_STAGES = new Set<RequestRecord["rail"]["stage"]>([
  "received",
  "processing",
  "delivered",
]);
/** The rail reported the deposit, or the buyer finished the provider's widget: the request no
 *  longer expires, however long the funds take to land. */
const isPaid = (record: RequestRecord): boolean =>
  PAID_STAGES.has(record.rail.stage) || record.meldSubmittedAt !== undefined;

/** Why the worker must be handed the request again, or null when it has the job in hand: it has
 *  no job for it (`unknown`), or it expired the job after the buyer paid (`expired`). */
function lostHandoff(record: RequestRecord): "unknown" | "expired" | null {
  const { worker } = record.witnesses;
  if (worker === undefined || !isWorkerDriven(record)) return null;
  if (!worker.known) return "unknown";
  return worker.failure === "expired" && isPaid(record) ? "expired" : null;
}

/** What this surface reads of a worker's stored job record. */
type WorkerJob = {
  phase?: string;
  done?: boolean;
  failure?: string;
  lastError?: string;
  lastTickAt?: number | null;
  state?: { fundsSeenAt?: number | null };
  claim?: { phase?: string; amount?: string; at?: number } | null;
  txs?: WorkerJobView["txs"];
  // The hand-off the worker keeps, read back when the surface has no record of the job.
  label?: string;
  burnerAddress?: string;
  depositExpiresAt?: number | null;
  settleAmount?: string;
  underlyingAssetId?: number;
  peopleParaId?: number;
  assetHubGenesis?: string;
  peopleGenesis?: string;
  remoteFeeBuffer?: string;
  keepNativeForFees?: string;
  createdAt?: number;
  armedAt?: number;
};

/** Every worker job, keyed by workerSessionId; {} when there are none. */
async function readWorkerJobs(): Promise<Record<string, WorkerJob>> {
  try {
    const raw = await (await getRecordStorage()).read(WORKER_JOBS_KEY);
    return raw === null ? {} : (JSON.parse(raw) as Record<string, WorkerJob>);
  } catch {
    return {};
  }
}

/** The job as the record's reducer reads it. */
function jobView(job: WorkerJob): WorkerJobView {
  const { claim } = job;
  return {
    phase: job.phase ?? "",
    done: job.done === true,
    ...(job.failure === undefined ? {} : { failure: job.failure }),
    ...(job.lastError === undefined ? {} : { lastError: job.lastError }),
    fundsSeenAt: job.state?.fundsSeenAt ?? null,
    lastTickAt: job.lastTickAt ?? null,
    claim:
      claim && (claim.phase === "claiming" || claim.phase === "claimed")
        ? {
            phase: claim.phase,
            ...(claim.amount === undefined ? {} : { amount: claim.amount }),
            at: claim.at ?? job.lastTickAt ?? Date.now(),
          }
        : null,
    ...(job.txs === undefined ? {} : { txs: job.txs }),
  };
}

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** The ref a worker session id names (`<sourceId>:<tradeN>`), or null for anything else. */
function refOfSessionId(sessionId: string): RequestRef | null {
  const separator = sessionId.lastIndexOf(":");
  if (separator <= 0) return null;
  const tail = sessionId.slice(separator + 1);
  if (!/^\d+$/.test(tail)) return null;
  const tradeN = Number(tail);
  if (!Number.isSafeInteger(tradeN) || tradeN < 1) return null;
  return requestRefOf(sessionId.slice(0, separator), tradeN);
}

/** The rail's deposit deadline on the job, or null when the rail gave none. */
const railExpiryOf = (job: WorkerJob): number | null =>
  isNumber(job.depositExpiresAt) && job.depositExpiresAt > 0 ? job.depositExpiresAt : null;

/** Today's `lastQuoteParams` for a source id: the rail and method of a Meld source, the chain and
 *  coin of a swap source, Asset Hub's own for the crypto rail's, the id itself otherwise. */
function displaySourceOf(sourceId: string): { chain: string; asset: string } {
  const route = routeOf(sourceId);
  if (route !== "crypto") return { chain: "Meld", asset: route === "bank" ? "Bank" : "Card" };
  if (sourceId === CRYPTO_SOURCE_ID) return { chain: "AssetHub", asset: "DOT" };
  for (const { chain, assets } of SOURCE_CHAINS) {
    for (const asset of assets) {
      if (sourceIdFor(chain, asset) === sourceId) return { chain, asset };
    }
  }
  return { chain: sourceId, asset: sourceId };
}

/** The snapshot a request starts with when its record is built from the worker's job: today's
 *  defaults for the source, with no quote to size the ingress from. */
function initialProgressForSource(sourceId: string, startedAt: number): FundingProgressSnapshot {
  const route = routeOf(sourceId);
  const provider = progressProviderForSource(sourceId);
  // A card confirms within minutes; a bank transfer takes business days.
  const profile =
    route === "crypto"
      ? provider.createProfile()
      : provider.createProfile({
          ingressDurationMs: route === "bank" ? 24 * 60 * MINUTE : 5 * MINUTE,
        });
  const journeyMs =
    profile.expectedUserDelayMs +
    profile.stages.reduce((total, stage) => total + stage.nominalMs, 0);
  return createFundingProgressSnapshot(profile, {
    preDetectionEstimateText:
      route === "crypto"
        ? "≈10 min after your transfer"
        : route === "bank"
          ? "1-2 business days after you pay"
          : "≈ minutes after you pay",
    estimatedCompletionAt: startedAt + journeyMs,
  });
}

/** The hand-off the worker keeps on its job, when every field is there. */
function handoffOf(job: WorkerJob): WorkerHandoffPayload | undefined {
  const {
    label,
    burnerAddress,
    settleAmount,
    underlyingAssetId,
    peopleParaId,
    assetHubGenesis,
    peopleGenesis,
    remoteFeeBuffer,
    keepNativeForFees,
  } = job;
  if (
    !isString(label) ||
    !isString(burnerAddress) ||
    !isString(settleAmount) ||
    !isNumber(underlyingAssetId) ||
    !isNumber(peopleParaId) ||
    !isString(assetHubGenesis) ||
    !isString(peopleGenesis) ||
    !isString(remoteFeeBuffer) ||
    !isString(keepNativeForFees)
  ) {
    return undefined;
  }
  return {
    label,
    burnerAddress,
    depositExpiresAt: railExpiryOf(job) ?? 0,
    settleAmount,
    underlyingAssetId,
    peopleParaId,
    assetHubGenesis,
    peopleGenesis,
    remoteFeeBuffer,
    keepNativeForFees,
  };
}

/** A record for a job the surface has no record of, the "chain knows, cache does not" case; it
 *  renders with generic labels. Null when the job lacks what a record needs. */
function recordFromJob(sessionId: string, job: WorkerJob): RequestRecord | null {
  const ref = refOfSessionId(sessionId);
  const { settleAmount, createdAt } = job;
  if (
    ref === null ||
    !isString(settleAmount) ||
    !/^\d+$/.test(settleAmount) ||
    !isNumber(createdAt)
  ) {
    return null;
  }
  const sourceId = effectiveSourceId(ref);
  const startedAt = createdAt;
  const railExpiry = railExpiryOf(job);
  // The default window counts from the arming, as the worker's own expiry does.
  const armedAt = isNumber(job.armedAt) ? job.armedAt : startedAt;
  const handoff = handoffOf(job);
  return {
    schema: 2,
    kind: "top-up",
    ref,
    rev: 0,
    updatedAt: startedAt,
    amountHuman: fmtCash(BigInt(settleAmount)),
    ...displaySourceOf(sourceId),
    startedAt,
    ...(isString(job.burnerAddress) ? { depositAddress: job.burnerAddress } : {}),
    progress: initialProgressForSource(sourceId, startedAt),
    tradeN: ref.tradeN,
    sourceId,
    ...(railExpiry === null ? {} : { depositExpiresAt: railExpiry }),
    route: routeOf(sourceId),
    deadline:
      railExpiry === null
        ? { depositExpiresAt: armedAt + DEFAULT_DEPOSIT_WINDOW_MS, source: "route" }
        : { depositExpiresAt: railExpiry, source: "rail" },
    ...(handoff === undefined ? {} : { handoff }),
    status: { kind: "awaiting-deposit" },
    rail: {
      provider: railProviderOf(sourceId),
      status: "waiting",
      stage: "waiting",
      updatedAt: startedAt,
    },
    witnesses: {},
  };
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

  /** Moves a record by one observation. A key with no record is left alone. A witness-only
   *  change reaches memory alone: the rev stays, nothing is written. */
  function observe(ref: RequestRef, observation: Observation): Promise<void> {
    const key = requestRefKey(ref);
    if (entries.value[key] === undefined) return Promise.resolve();
    return enqueue(key, async () => {
      const entry = entries.value[key];
      if (entry === undefined) return;
      const reduced = reduce(entry.record, observation);
      if (reduced === entry.record) return;
      if (witnessOnly(entry.record, reduced)) {
        patchEntry(key, (current) => ({ ...current, record: reduced }));
        return;
      }
      const next = { ...reduced, rev: entry.record.rev + 1 };
      await commit(key, next, isCritical(entry.record, next));
    });
  }

  // Interim path for the provider progress signals until milestone 6 routes the provider signals
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

  /** Stores the hand-off a legacy record was started without, so no later re-send needs a world.
   *  Observation-free, like `flag`. */
  function setHandoff(ref: RequestRef, handoff: WorkerHandoffPayload): Promise<void> {
    const key = requestRefKey(ref);
    if (entries.value[key] === undefined) return Promise.resolve();
    return enqueue(key, async () => {
      const entry = entries.value[key];
      if (entry === undefined) return;
      const { record } = entry;
      await commit(key, { ...record, rev: record.rev + 1, handoff }, false);
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

  /** Reconcile step 2, and the poll's tick: one read of the worker's blob; every record the
   *  worker can still move observes its job (`known: false` without one), and a job with no
   *  record gets one, created from the job and then observed with it. */
  async function observeWorkerJobs(now: number): Promise<void> {
    const jobs = await readWorkerJobs();
    const known = new Set<string>();
    const observed: Promise<void>[] = [];
    for (const record of records.value) {
      const { ref } = record;
      const sessionId = workerSessionId(effectiveSourceId(ref), ref.tradeN);
      known.add(sessionId);
      if (!followsWorker(record)) continue;
      const job = jobs[sessionId];
      observed.push(observe(ref, { source: "worker", at: now, job: job ? jobView(job) : null }));
    }
    for (const [sessionId, job] of Object.entries(jobs)) {
      // A cancelled request whose record is gone must not come back as a pending row.
      if (!job || known.has(sessionId) || job.failure === "cancelled") continue;
      const record = recordFromJob(sessionId, job);
      if (record === null) continue;
      observed.push(
        create(record.ref, record)
          .then(() => observe(record.ref, { source: "worker", at: now, job: jobView(job) }))
          .catch((e: unknown) => {
            console.warn(`[requests] record for worker job ${sessionId} failed: ${messageOf(e)}`);
          }),
      );
    }
    await Promise.all(observed);
  }

  /** The key of the request on screen. Its own world hands it to the worker; the hand-off step
   *  leaves it alone. */
  const foreground = ref<RequestKey | null>(null);
  const foregroundEntry = computed<RequestEntry | null>(() =>
    foreground.value === null ? null : (entries.value[foreground.value] ?? null),
  );
  const foregroundRecord = computed<RequestRecord | null>(
    () => foregroundEntry.value?.record ?? null,
  );
  function setForeground(ref: RequestRef | null): void {
    foreground.value = ref === null ? null : requestRefKey(ref);
  }

  // The foreground clock: while the request on screen awaits its deposit, one clock observation a
  // second lets the reducer expire it at its deadline. Witness-only ticks cost nothing.
  let foregroundClock: ReturnType<typeof setInterval> | null = null;
  function startForegroundClock(): void {
    if (foregroundClock !== null) return;
    foregroundClock = setInterval(() => {
      const record = foregroundRecord.value;
      if (record !== null) void observe(record.ref, { source: "clock", at: requestsNow() });
    }, 1_000);
  }
  function stopForegroundClock(): void {
    if (foregroundClock === null) return;
    clearInterval(foregroundClock);
    foregroundClock = null;
  }
  watch(
    () => foregroundRecord.value?.status.kind === "awaiting-deposit",
    (awaiting) => {
      if (awaiting) startForegroundClock();
      else stopForegroundClock();
    },
    { immediate: true },
  );

  /** The request on screen is gone: the clock stops and no key is foreground. */
  function leave(): void {
    stopForegroundClock();
    setForeground(null);
  }

  /** `work` settled within the cancel's bound, or why not. */
  type Bounded<T> = { ok: true; value: T } | { ok: false; reason: string };
  function withinCancelBound<T>(label: string, work: Promise<T>): Promise<Bounded<T>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<Bounded<T>>((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, reason: `${label} did not answer in time` }),
        CANCEL_CONFIRM_MS,
      );
    });
    const outcome = work.then(
      (value): Bounded<T> => ({ ok: true, value }),
      (e: unknown): Bounded<T> => ({ ok: false, reason: `${label} failed: ${messageOf(e)}` }),
    );
    return Promise.race([outcome, expiry]).finally(() => clearTimeout(timer));
  }

  /** The job's own money observation: it saw funds, or it is past waiting for them. */
  const jobHasFunds = (job: WorkerJobView): boolean =>
    job.fundsSeenAt !== null ||
    (job.phase !== "starting" && job.phase !== "await-native" && job.phase !== "failed");

  /** The last look before a cancel: the burner and the worker's job, each read within
   *  `CANCEL_CONFIRM_MS`. Funds in either refuse the cancel and reach the record as the read that
   *  found them; a read that did not answer leaves the cancel unconfirmed. */
  async function cancel(
    ref: RequestRef,
    opts: { readBurner: () => Promise<bigint> },
  ): Promise<"ok" | "refused" | "unconfirmed"> {
    const at = requestsNow();
    const [burner, jobs] = await Promise.all([
      withinCancelBound("the burner read", opts.readBurner()),
      withinCancelBound("the worker job read", readWorkerJobs()),
    ]);
    if (burner.ok && burner.value > 0n) {
      await observe(ref, {
        source: "chain",
        at,
        burnerNative: burner.value.toString(),
        finality: "best",
        via: "pre-cancel",
      });
      return "refused";
    }
    const job = jobs.ok
      ? jobs.value[workerSessionId(effectiveSourceId(ref), ref.tradeN)]
      : undefined;
    if (job) {
      const view = jobView(job);
      if (jobHasFunds(view)) {
        await observe(ref, { source: "worker", at, job: view });
        return "refused";
      }
    }
    for (const read of [burner, jobs]) {
      if (!read.ok) {
        console.warn(`[requests] cancel unconfirmed: ${read.reason}`);
        return "unconfirmed";
      }
    }
    return "ok";
  }

  /** A user retry: only a recoverably failed record whose failure the worker's job, or core's
   *  own failed witness, confirms is moved back into the pipeline. */
  async function retry(ref: RequestRef): Promise<boolean> {
    const record = get(ref);
    if (record === undefined || record.status.kind !== "failed" || !record.status.recoverable) {
      return false;
    }
    const jobs = await readWorkerJobs();
    const job = jobs[workerSessionId(effectiveSourceId(ref), ref.tradeN)];
    const confirmedByJob =
      job !== undefined &&
      job.phase === "failed" &&
      (job.failure === "shortfall" || job.failure === "timeout");
    if (!confirmedByJob && record.witnesses.core?.phase !== "failed") {
      console.warn("[requests] retry ignored: the failure is not confirmed as recoverable");
      return false;
    }
    await observe(ref, { source: "user", at: requestsNow(), event: "retry" });
    return true;
  }

  /** The buyer finished the provider's widget; the stamp is on the host before this resolves. */
  function markMeldSubmitted(ref: RequestRef): Promise<void> {
    return observe(ref, { source: "user", at: requestsNow(), event: "meld-submitted" });
  }

  /** Reconcile step 6: the worker is handed every open request it lost, off screen only. A job it
   *  has no record of gets the request's stored hand-off as it is; a job it expired after the
   *  buyer paid gets it with a fresh deadline, because the worker keeps the hand-off's own; a
   *  legacy record without a hand-off builds one hosted world to obtain it, stores it and lets the
   *  world go. Nothing here observes the record: the worker's answer arrives with the next job
   *  read. A failure is noted on the entry and the next reconcile tries again. */
  async function handOffLostRequests(now: number): Promise<void> {
    if (!isHosted()) return;
    const lost = records.value.flatMap((record) => {
      const reason = lostHandoff(record);
      return reason === null || requestRefKey(record.ref) === foreground.value
        ? []
        : [{ record, reason }];
    });
    if (lost.length === 0) return;
    const [{ getStorageWorkerManager }, { createHostedCoinageWorld, ensureChainSubmitGrant }] =
      await Promise.all([import("~~/lib/worker-rpc"), import("~~/lib/coinage-live")]);
    // The worker submits on the user's behalf; the grant is requested before the first send.
    await ensureChainSubmitGrant();
    const worker = getStorageWorkerManager();

    async function obtainHandoff(record: RequestRecord): Promise<WorkerHandoffPayload> {
      const { ref } = record;
      const amount = toCashBase(record.amountHuman);
      if (amount === null) throw new Error(`'${record.amountHuman}' is not a CASH amount`);
      const world = await createHostedCoinageWorld({
        amount,
        tradeN: ref.tradeN,
        sourceId: effectiveSourceId(ref) as SourceId,
      });
      try {
        const handoff = await world.handoffPayload();
        await setHandoff(ref, handoff);
        return handoff;
      } finally {
        world.dispose();
      }
    }
    // Worlds are built one at a time; a failed build never blocks the next.
    let building: Promise<unknown> = Promise.resolve();
    function buildHandoff(record: RequestRecord): Promise<WorkerHandoffPayload> {
      const run = () => obtainHandoff(record);
      const next = building.then(run, run);
      building = next.catch(() => {});
      return next;
    }

    await Promise.all(
      lost.map(async ({ record, reason }) => {
        const { ref } = record;
        const key = requestRefKey(ref);
        try {
          const stored = record.handoff ?? (await buildHandoff(record));
          const payload =
            reason === "expired"
              ? { ...stored, depositExpiresAt: now + DEFAULT_DEPOSIT_WINDOW_MS }
              : stored;
          await sendHandoff(worker, workerSessionId(effectiveSourceId(ref), ref.tradeN), payload);
          patchEntry(key, ({ handoffError: _cleared, ...sent }) => sent);
        } catch (e) {
          const handoffError = messageOf(e);
          console.warn(`[requests] hand-off for ${key} failed: ${handoffError}`);
          patchEntry(key, (current) => ({ ...current, handoffError }));
        }
      }),
    );
  }

  // The job poll: one blob read every JOB_POLL_MS while the page is visible and a request is at
  // rank 0–3. Milestone 7 wires the visibility events.
  let jobPollTimer: ReturnType<typeof setInterval> | null = null;
  let jobPollTick: Promise<void> | null = null;
  const anyWorkerDriven = (): boolean => records.value.some(isWorkerDriven);
  const pageVisible = (): boolean =>
    typeof document === "undefined" || document.visibilityState !== "hidden";

  function startJobPoll(): void {
    if (jobPollTimer !== null) return;
    jobPollTimer = setInterval(() => void pollJobs(), JOB_POLL_MS);
  }
  function stopJobPoll(): void {
    if (jobPollTimer === null) return;
    clearInterval(jobPollTimer);
    jobPollTimer = null;
  }
  /** One tick. Single-flight: a tick arriving while the previous one runs joins it, one while
   *  hidden is skipped, and one that finds no request at rank 0–3 stops the poll. */
  function pollJobs(): Promise<void> {
    if (jobPollTick !== null) return jobPollTick;
    if (!anyWorkerDriven()) {
      stopJobPoll();
      return Promise.resolve();
    }
    if (!pageVisible()) return Promise.resolve();
    jobPollTick = observeWorkerJobs(requestsNow())
      .catch((e: unknown) => {
        console.warn(`[requests] job poll failed: ${messageOf(e)}`);
      })
      .finally(() => {
        jobPollTick = null;
        if (!anyWorkerDriven()) stopJobPoll();
      });
    return jobPollTick;
  }
  /** The poll runs while a request is at rank 0–3, and not otherwise. */
  function syncJobPoll(): void {
    if (anyWorkerDriven()) startJobPoll();
    else stopJobPoll();
  }

  let reconciling: Promise<void> | null = null;
  let reconcileAgain = false;
  /** Brings memory up to date with the host store, then with the worker's jobs, then lets the
   *  clock expire what it must. Single-flight: a caller arriving mid-run makes it run once more. */
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

    try {
      await observeWorkerJobs(now);
    } catch (e) {
      console.warn(`[requests] reconcile (${reason}): worker jobs step failed: ${messageOf(e)}`);
    }

    try {
      await handOffLostRequests(now);
    } catch (e) {
      console.warn(`[requests] reconcile (${reason}): hand-off step failed: ${messageOf(e)}`);
    }

    await Promise.all(
      records.value
        .filter((record) => rankOf(record) === 0)
        .map((record) => observe(record.ref, { source: "clock", at: now })),
    );
    syncJobPoll();
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
    setHandoff,
    remove,
    foreground,
    foregroundEntry,
    foregroundRecord,
    setForeground,
    leave,
    cancel,
    retry,
    markMeldSubmitted,
    startForegroundClock,
    stopForegroundClock,
    hydrateFromMirror,
    writeMirror,
    reconcile,
    startJobPoll,
    stopJobPoll,
    flush,
  };
});
