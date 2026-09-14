// The requests store: every record owned in one map, moved by the reducer, mirrored on each
// change and persisted beneath; today's list and statuses derived from it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { projectChainflipTopUps } from "../app/funding/chainflip-top-ups";
import { projectMeldTopUps } from "../app/funding/meld-top-ups";
import { migrateRecord } from "../app/funding/requests/migrate";
import {
  COALESCE_MS,
  DEPOSIT_EXPIRED_REASON,
  setRequestsClock,
  type Observation,
  type RequestRecord,
} from "../app/funding/requests/model";
import {
  createMemoryKeyedStorage,
  isMirrorAvailable,
  MIRROR_KEY,
  REQUEST_INDEX_KEY,
  requestKey,
  setMirrorStorage,
  setRecordStorage,
  type KeyedStorage,
  type WebStorageLike,
} from "../app/funding/requests/storage";
import { useRequestsStore } from "../app/stores/requests";
import { useSessionStore, type ActiveFlowRecord, type RequestStatus } from "../app/stores/session";
import {
  parseRequestIndex,
  requestRefKey,
  requestRefOf,
  serializeRequestIndex,
  type RequestRef,
} from "../app/utils/request-index";
import {
  awaitingDepositCryptoRecord,
  cancelledCryptoRecord,
  failedCryptoRecord,
  FIXTURE_NOW,
  fixtureRecords,
  LEGACY_BARE_REF_KEY,
  legacyBareRefRecord,
  settledCardRecord,
} from "./fixtures/requests";

// `enterRequest` always builds the hosted world, and outside the Polkadot App the host managers
// are missing, so the world never gets as far as its flow slot. This world hydrates and has none.
vi.mock("../lib/coinage-live", () => ({
  DEFAULT_SOURCE_ID: "dot-assethub",
  probeTradeBurner: async () => ({ address: "", free: 0n }),
  createHostedCoinageWorld: async (args: { tradeN?: number; sourceId?: string }) => ({
    session: { ready: Promise.resolve(), peek: () => null, dispose() {} },
    sourceId: args.sourceId ?? "dot-assethub",
    tradeN: args.tradeN ?? 1,
    refundAddress: null,
    revealRefundKey: () => null,
    dispose() {},
  }),
}));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Minutes after the fixture instant. */
const at = (minutes: number) => FIXTURE_NOW + minutes * MINUTE;

/** The ref a fixture is stored under: its own source id and trade number. */
const refOf = (record: ActiveFlowRecord): RequestRef =>
  requestRefOf(record.sourceId, record.tradeN!);
const AWAITING_REF = refOf(awaitingDepositCryptoRecord);
const AWAITING_KEY = requestRefKey(AWAITING_REF);
const LEGACY_REF: RequestRef = { tradeN: 7 };

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

/** A record storage whose reads and writes reject on demand, per key, counting the writes that
 *  landed under each key. */
function faultableStorage() {
  const inner = createMemoryKeyedStorage();
  const rejectReads = new Set<string>();
  const rejectWrites = new Set<string>();
  const writes = new Map<string, number>();
  const storage: KeyedStorage = {
    read: (key) =>
      rejectReads.has(key) ? Promise.reject(new Error(`read failed: ${key}`)) : inner.read(key),
    write: (key, value) => {
      if (rejectWrites.has(key)) return Promise.reject(new Error(`write failed: ${key}`));
      writes.set(key, (writes.get(key) ?? 0) + 1);
      return inner.write(key, value);
    },
    clear: (key) => inner.clear(key),
  };
  const writesTo = (key: string) => writes.get(key) ?? 0;
  const totalWrites = () => [...writes.values()].reduce((sum, n) => sum + n, 0);
  return { storage, rejectReads, rejectWrites, writesTo, totalWrites };
}

let host: ReturnType<typeof faultableStorage>;
let mirror: ReturnType<typeof fakeWebStorage>;

/** Stores the records under their keys and lists them in the index, as today's writers do. */
async function seed(records: readonly ActiveFlowRecord[]): Promise<RequestRef[]> {
  const refs = records.map(refOf);
  for (const record of records) {
    await host.storage.write(requestKey(refOf(record)), JSON.stringify(record));
  }
  await host.storage.write(REQUEST_INDEX_KEY, serializeRequestIndex(refs));
  return refs;
}

async function stored(ref: RequestRef): Promise<Record<string, unknown> | null> {
  const raw = await host.storage.read(requestKey(ref));
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

async function storedIndex(): Promise<RequestRef[]> {
  return parseRequestIndex(await host.storage.read(REQUEST_INDEX_KEY));
}

const migrated = (record: ActiveFlowRecord, ref = refOf(record)): RequestRecord => {
  const result = migrateRecord(record, ref, FIXTURE_NOW);
  if (result === null) throw new Error("fixture did not migrate");
  return result;
};

/** The worker's swap step: it saw the funds and started converting. */
const workerSwap = (time: number): Observation => ({
  source: "worker",
  at: time,
  job: { phase: "swap", done: false, fundsSeenAt: time, lastTickAt: time, claim: null },
});
/** The worker's claim: the request settles. */
const workerClaimed = (time: number, amount: string): Observation => ({
  source: "worker",
  at: time,
  job: {
    phase: "done",
    done: true,
    fundsSeenAt: time,
    lastTickAt: time,
    claim: { phase: "claimed", amount, at: time },
  },
});
/** An empty burner read: a witness, nothing more. */
const chainEmpty = (time: number): Observation => ({
  source: "chain",
  at: time,
  burnerNative: "0",
  finality: "best",
  via: "probe",
});
/** Funds on the burner at the best block: the deposit is seen, provisionally. */
const chainFunds = (time: number): Observation => ({
  source: "chain",
  at: time,
  burnerNative: "250000000000",
  finality: "best",
  via: "probe",
});

describe("requests store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    host = faultableStorage();
    setRecordStorage(host.storage);
    mirror = fakeWebStorage();
    setMirrorStorage(mirror);
    setRequestsClock(() => FIXTURE_NOW);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    // A coalesced write left pending would land in the next test's storage, and so would a poll.
    const requests = useRequestsStore();
    requests.stopJobPoll();
    await requests.flush();
    vi.restoreAllMocks();
    setRequestsClock(Date.now);
    setMirrorStorage(null);
  });

  it("create writes the record, the index and the mirror", async () => {
    const requests = useRequestsStore();
    const record = migrated(awaitingDepositCryptoRecord);
    await requests.create(AWAITING_REF, record);

    expect(requests.has(AWAITING_REF)).toBe(true);
    expect(requests.get(AWAITING_REF)).toBe(record);
    expect(requests.entries[AWAITING_KEY]).toEqual({ record, pendingWrite: false });

    const written = await stored(AWAITING_REF);
    expect(written).toMatchObject({
      schema: 2,
      kind: "top-up",
      ref: AWAITING_REF,
      rev: 0,
      status: { kind: "awaiting-deposit" },
      rail: { provider: "manual", status: "waiting", stage: "waiting" },
    });
    const { progress: _resolved, ...legacy } = awaitingDepositCryptoRecord;
    expect(written).toMatchObject(legacy);
    expect(await storedIndex()).toEqual([AWAITING_REF]);

    const mirrored = JSON.parse(mirror.entries.get(MIRROR_KEY)!) as {
      schema: number;
      writtenAt: number;
      index: RequestRef[];
      records: Record<string, unknown>;
    };
    expect(mirrored).toMatchObject({ schema: 2, writtenAt: FIXTURE_NOW, index: [AWAITING_REF] });
    expect(mirrored.records[AWAITING_KEY]).toEqual(JSON.parse(JSON.stringify(record)));

    await expect(requests.create(AWAITING_REF, record)).rejects.toThrow(/already has a record/);
  });

  it("list and statuses equal the milestone-0 snapshot for the fixtures", async () => {
    await seed(fixtureRecords);
    const requests = useRequestsStore();
    await requests.reconcile("boot");

    // Today's list never held the cancelled record (`openRequests` dropped it), and today's
    // reconcile marked the legacy request failed once its window had closed: the milestone-0
    // snapshot projected the raw fixtures, before either.
    const open = fixtureRecords.filter((record) => record.cancelledAt === undefined);
    const expired = { "#7": { kind: "failed", reason: DEPOSIT_EXPIRED_REASON } } satisfies Record<
      string,
      RequestStatus
    >;
    expect(projectChainflipTopUps(requests.list, requests.statuses, FIXTURE_NOW)).toEqual(
      projectChainflipTopUps(open, expired, FIXTURE_NOW),
    );
    expect(projectMeldTopUps(requests.list, requests.statuses, FIXTURE_NOW)).toEqual(
      projectMeldTopUps(open, {}, FIXTURE_NOW),
    );
    expect(requests.statuses).toEqual({
      ...expired,
      "dot-assethub#2": { kind: "failed", reason: failedCryptoRecord.failureReason },
    });
    expect(requests.list.map((row) => requestRefKey(refOf(row)))).toEqual([
      "dot-assethub#4",
      "dot-assethub#3",
      "meld-card#2",
      "dot-assethub#2",
      "meld-card#1",
      "#7",
    ]);
    expect(requests.hostReadDone).toBe(true);
  });

  it("a rejected record read keeps the entry and the index", async () => {
    const refs = await seed(fixtureRecords);
    const unparseable = refOf(fixtureRecords[0]!);
    await host.storage.write(requestKey(unparseable), "{not json");
    const requests = useRequestsStore();
    await requests.reconcile("boot");
    // Unparseable and never in memory: skipped, and still listed.
    expect(requests.has(unparseable)).toBe(false);
    expect(requests.has(AWAITING_REF)).toBe(true);

    host.rejectReads.add(requestKey(AWAITING_REF));
    await requests.reconcile("refresh");
    expect(requests.entries[AWAITING_KEY]).toMatchObject({
      readError: expect.stringContaining("read failed"),
    });
    expect(requests.list.some((row) => requestRefKey(refOf(row)) === AWAITING_KEY)).toBe(true);
    expect(await storedIndex()).toEqual(parseRequestIndex(serializeRequestIndex(refs)));

    host.rejectReads.delete(requestKey(AWAITING_REF));
    await requests.reconcile("refresh");
    expect(requests.entries[AWAITING_KEY]?.readError).toBeUndefined();
  });

  it("a legacy record is migrated in memory and written back as schema 2 on its first change", async () => {
    // A minute into the legacy request's life, well inside its window.
    setRequestsClock(() => legacyBareRefRecord.startedAt + MINUTE);
    expect(requestKey(LEGACY_REF)).toBe(LEGACY_BARE_REF_KEY);
    await seed([legacyBareRefRecord]);
    const requests = useRequestsStore();
    await requests.reconcile("boot");

    // Migrated at rev 0; the reconcile's worker read (no job) and clock only witness it, which
    // bumps nothing.
    const inMemory = requests.get(LEGACY_REF);
    expect(inMemory).toMatchObject({ schema: 2, ref: LEGACY_REF, rev: 0, route: "crypto" });
    expect(inMemory?.status).toEqual({ kind: "awaiting-deposit" });
    // Reading writes nothing back.
    expect(await stored(LEGACY_REF)).toEqual(legacyBareRefRecord);
    expect(await storedIndex()).toEqual([LEGACY_REF]);

    const seenAt = legacyBareRefRecord.startedAt + 2 * MINUTE;
    await requests.observe(LEGACY_REF, workerSwap(seenAt));
    const written = await stored(LEGACY_REF);
    expect(written).toMatchObject({
      ...legacyBareRefRecord,
      schema: 2,
      kind: "top-up",
      ref: LEGACY_REF,
      rev: 1,
      funded: seenAt,
      status: { kind: "converting", at: seenAt, step: "swap" },
    });
    expect(written).not.toHaveProperty("sourceId");
  });

  it("cancelled records are excluded from list but not removed; eleven settled records survive", async () => {
    const settled = Array.from({ length: 11 }, (_, i): ActiveFlowRecord => {
      const shift = (i + 1) * HOUR;
      return {
        ...settledCardRecord,
        tradeN: 11 + i,
        startedAt: settledCardRecord.startedAt - shift,
        meldSubmittedAt: settledCardRecord.meldSubmittedAt! - shift,
        funded: settledCardRecord.funded! - shift,
        settledAt: settledCardRecord.settledAt! - shift,
      };
    });
    const refs = await seed([...fixtureRecords, ...settled]);
    const requests = useRequestsStore();
    await requests.reconcile("boot");

    const cancelled = refOf(cancelledCryptoRecord);
    expect(requests.get(cancelled)?.status).toEqual({
      kind: "cancelled",
      at: cancelledCryptoRecord.cancelledAt,
    });
    expect(requests.list.map((row) => requestRefKey(refOf(row)))).not.toContain(
      requestRefKey(cancelled),
    );
    expect(await stored(cancelled)).toEqual(cancelledCryptoRecord);

    expect(requests.records).toHaveLength(refs.length);
    expect(requests.list.filter((row) => row.settledAt !== undefined)).toHaveLength(12);
    for (const record of settled) expect(await stored(refOf(record))).toEqual(record);
    expect((await storedIndex()).map(requestRefKey).sort()).toEqual(refs.map(requestRefKey).sort());

    // Another pass reads no settled record again and drops nothing either.
    await requests.reconcile("refresh");
    expect(requests.records).toHaveLength(refs.length);
    expect((await storedIndex()).length).toBe(refs.length);
  });

  it("hydrateFromMirror populates the store before any host read", async () => {
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
    expect(host.totalWrites()).toBe(0);
    expect(requests.records).toHaveLength(fixtureRecords.length);
    expect(requests.list.map((row) => requestRefKey(refOf(row)))).toEqual([
      "dot-assethub#4",
      "dot-assethub#3",
      "meld-card#2",
      "dot-assethub#2",
      "meld-card#1",
      "#7",
    ]);
    for (const entry of Object.values(requests.entries)) expect(entry.pendingWrite).toBe(false);

    // The host has nothing: the first reconcile keeps every entry and lists the refs it knows.
    await requests.reconcile("boot");
    expect(requests.hostReadDone).toBe(true);
    expect(requests.records).toHaveLength(fixtureRecords.length);
    expect((await storedIndex()).map(requestRefKey).sort()).toEqual(Object.keys(records).sort());
  });

  it("a throwing mirror write disables the mirror for the session", async () => {
    const removed: string[] = [];
    let writes = 0;
    setMirrorStorage({
      getItem: () => null,
      setItem: () => {
        writes += 1;
        throw new Error("QuotaExceededError");
      },
      removeItem: (key) => {
        removed.push(key);
      },
    });
    const requests = useRequestsStore();
    expect(isMirrorAvailable()).toBe(true);

    const record = migrated(awaitingDepositCryptoRecord);
    await requests.create(AWAITING_REF, record);
    expect(isMirrorAvailable()).toBe(false);
    expect(removed).toEqual([MIRROR_KEY]);
    expect(writes).toBe(1);
    // The host still got the record, and later changes never try the mirror again.
    expect(await stored(AWAITING_REF)).toMatchObject({ rev: 0 });
    await requests.observe(AWAITING_REF, chainFunds(at(1)));
    expect(writes).toBe(1);
    expect(requests.get(AWAITING_REF)?.status.kind).toBe("deposit-seen");
    expect(await stored(AWAITING_REF)).toMatchObject({ rev: 1 });
  });

  it("critical transitions are persisted before observe resolves; progress writes are coalesced", async () => {
    await seed([awaitingDepositCryptoRecord]);
    const requests = useRequestsStore();
    // A reconcile only witnesses the record: rev 0, nothing written.
    await requests.reconcile("boot");
    const key = requestKey(AWAITING_REF);
    const before = host.writesTo(key);

    // The deposit's sighting is on the host before the observation resolves.
    await requests.observe(AWAITING_REF, chainFunds(at(1)));
    expect(host.writesTo(key)).toBe(before + 1);
    expect(await stored(AWAITING_REF)).toMatchObject({
      rev: 1,
      status: { kind: "deposit-seen" },
    });

    // A witness-only read moves memory and nothing else.
    await requests.observe(AWAITING_REF, chainEmpty(at(2)));
    expect(requests.get(AWAITING_REF)).toMatchObject({
      rev: 1,
      witnesses: { chain: { best: { burnerNative: "0", at: at(2) } } },
    });
    expect(requests.entries[AWAITING_KEY]?.pendingWrite).toBe(false);

    // Two non-critical writes inside the window: memory moves at once, the host once, later.
    await requests.flag(AWAITING_REF, "first note");
    await requests.flag(AWAITING_REF, "second note");
    expect(requests.get(AWAITING_REF)?.rev).toBe(3);
    expect(requests.entries[AWAITING_KEY]?.pendingWrite).toBe(true);
    expect(host.writesTo(key)).toBe(before + 1);
    expect(await stored(AWAITING_REF)).toMatchObject({ rev: 1 });
    await new Promise((resolve) => setTimeout(resolve, COALESCE_MS + 50));
    expect(host.writesTo(key)).toBe(before + 2);
    expect(await stored(AWAITING_REF)).toMatchObject({ rev: 3 });
    expect(requests.entries[AWAITING_KEY]?.pendingWrite).toBe(false);

    // `flush` lands a pending write without waiting for the window.
    await requests.flag(AWAITING_REF, "third note");
    expect(host.writesTo(key)).toBe(before + 2);
    await requests.flush();
    expect(host.writesTo(key)).toBe(before + 3);
    expect(await stored(AWAITING_REF)).toMatchObject({ rev: 4 });
  });

  it("a host write rejection keeps memory and retries on the next observation", async () => {
    await seed([awaitingDepositCryptoRecord]);
    const requests = useRequestsStore();
    await requests.reconcile("boot");
    const key = requestKey(AWAITING_REF);

    host.rejectWrites.add(key);
    await requests.observe(AWAITING_REF, chainFunds(at(1)));
    expect(requests.get(AWAITING_REF)).toMatchObject({ rev: 1, status: { kind: "deposit-seen" } });
    expect(requests.entries[AWAITING_KEY]).toMatchObject({
      pendingWrite: true,
      persistError: expect.stringContaining("write failed"),
    });
    expect(await stored(AWAITING_REF)).toEqual(awaitingDepositCryptoRecord);

    host.rejectWrites.delete(key);
    await requests.observe(AWAITING_REF, workerClaimed(at(2), "25250000"));
    expect(requests.entries[AWAITING_KEY]).toEqual({
      record: requests.get(AWAITING_REF),
      pendingWrite: false,
    });
    expect(await stored(AWAITING_REF)).toMatchObject({
      rev: 2,
      status: { kind: "settled", at: at(2) },
      funded: at(1),
      settledAt: at(2),
      claimed: "25250000",
    });
  });

  it("enterRequest with a missing slot returns false and keeps the record", async () => {
    await seed([awaitingDepositCryptoRecord]);
    const requests = useRequestsStore();
    const session = useSessionStore();

    expect(await session.openRequest(AWAITING_REF)).toBe(false);
    expect(session.phase).toBeNull();
    // The conflict note is queued behind the resume; let it land and reach the host.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await requests.flush();

    // The reconcile on the way in only witnesses the record; the flag is its first change.
    expect(requests.has(AWAITING_REF)).toBe(true);
    expect(requests.get(AWAITING_REF)).toMatchObject({
      rev: 1,
      status: { kind: "awaiting-deposit" },
      witnesses: {
        conflict: { source: "core", note: "core slot missing on resume", at: FIXTURE_NOW },
      },
    });
    expect(await stored(AWAITING_REF)).toMatchObject({
      schema: 2,
      rev: 1,
      witnesses: { conflict: { source: "core" } },
    });
    expect(await storedIndex()).toEqual([AWAITING_REF]);
    expect(session.requestList.map((row) => requestRefKey(refOf(row)))).toEqual([AWAITING_KEY]);
  });
});
