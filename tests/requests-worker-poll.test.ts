// One worker poll: the store reads the worker's job blob in one place, every open request follows
// its job within a tick, and a job the surface never recorded becomes a record.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { projectChainflipTopUps } from "../app/funding/chainflip-top-ups";
import { progressProviderForSource } from "../app/funding/progress";
import { migrateRecord } from "../app/funding/requests/migrate";
import { JOB_POLL_MS, setRequestsClock, type RequestRecord } from "../app/funding/requests/model";
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
import type { ActiveFlowRecord } from "../app/stores/session";
import {
  parseRequestIndex,
  requestRefKey,
  requestRefOf,
  sameRequestRef,
  serializeRequestIndex,
  type RequestRef,
} from "../app/utils/request-index";
import {
  awaitingDepositCryptoRecord,
  FIXTURE_NOW,
  fixtureRecords,
  fixtureWorkerJobs,
  fixtureWorkerJobsBlob,
  settledCardRecord,
  submittedCardRecord,
  type WorkerJobRecord,
} from "./fixtures/requests";

/** The ref a fixture is stored under: its own source id and trade number. */
const refOf = (record: ActiveFlowRecord): RequestRef =>
  requestRefOf(record.sourceId, record.tradeN!);

const migrated = (record: ActiveFlowRecord, ref: RequestRef): RequestRecord => {
  const result = migrateRecord(record, ref, FIXTURE_NOW);
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

/** A memory record storage that counts the reads of the worker's blob. */
function countingStorage() {
  const inner = createMemoryKeyedStorage();
  let blobReads = 0;
  const storage: KeyedStorage = {
    read: (key) => {
      if (key === WORKER_JOBS_KEY) blobReads += 1;
      return inner.read(key);
    },
    write: (key, value) => inner.write(key, value),
    clear: (key) => inner.clear(key),
  };
  return { storage, blobReads: () => blobReads };
}

let host: ReturnType<typeof countingStorage>;
/** The store's clock; the poll tests move it along with the timers. */
let now: number;

/** Stores the records under their keys, lists them in the index, and stores the worker's blob:
 *  the fixture jobs unless a test narrows them. */
async function seed(
  records: readonly ActiveFlowRecord[],
  jobsBlob = fixtureWorkerJobsBlob,
): Promise<void> {
  for (const record of records) {
    await host.storage.write(requestKey(refOf(record)), JSON.stringify(record));
  }
  await host.storage.write(REQUEST_INDEX_KEY, serializeRequestIndex(records.map(refOf)));
  await host.storage.write(WORKER_JOBS_KEY, jobsBlob);
}

/** Replaces the worker's blob, as the worker does on its own tick. */
function writeJobs(jobs: Record<string, WorkerJobRecord>): Promise<void> {
  return host.storage.write(WORKER_JOBS_KEY, JSON.stringify(jobs));
}

async function stored(ref: RequestRef): Promise<Record<string, unknown> | null> {
  const raw = await host.storage.read(requestKey(ref));
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

const AWAITING_REF = refOf(awaitingDepositCryptoRecord);
/** The worker's job for the awaiting crypto request: armed, no deposit yet. */
const AWAITING_JOB = fixtureWorkerJobs["dot-assethub:3"]!;
/** A blob with that one job, so nothing else gets a record. */
const AWAITING_JOB_BLOB = JSON.stringify({ "dot-assethub:3": AWAITING_JOB });

describe("requests store: the worker poll", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    host = countingStorage();
    setRecordStorage(host.storage);
    setMirrorStorage(fakeWebStorage());
    now = FIXTURE_NOW;
    setRequestsClock(() => now);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    // Neither a poll nor a coalesced write may outlive its test.
    const requests = useRequestsStore();
    requests.stopJobPoll();
    await requests.flush();
    vi.useRealTimers();
    vi.restoreAllMocks();
    setRequestsClock(Date.now);
    setMirrorStorage(null);
  });

  it("reconcile settles a record whose job is claimed", async () => {
    // The surface last wrote the card request before the worker claimed it.
    const { settledAt: _settledAt, claimed: _claimed, ...claimedWhileClosed } = settledCardRecord;
    await seed(
      fixtureRecords.map((record) => (record === settledCardRecord ? claimedWhileClosed : record)),
    );
    const requests = useRequestsStore();
    await requests.reconcile("boot");

    const ref = refOf(settledCardRecord);
    const claim = fixtureWorkerJobs["meld-card:1"]!.claim!;
    expect(requests.get(ref)).toMatchObject({
      rev: 1,
      status: { kind: "settled", at: claim.at },
      settledAt: claim.at,
      claimed: claim.amount,
      confirmedAt: FIXTURE_NOW,
      witnesses: {
        worker: { known: true, phase: "done", done: true, claimPhase: "claimed", at: FIXTURE_NOW },
      },
    });
    // Settled is critical: on the host before the reconcile resolves.
    expect(await stored(ref)).toMatchObject({
      rev: 1,
      status: { kind: "settled", at: claim.at },
      settledAt: claim.at,
      claimed: claim.amount,
    });
    expect(requests.statuses[requestRefKey(ref)]).toBeUndefined();
    expect(requests.list.find((row) => sameRequestRef(refOf(row), ref))?.settledAt).toBe(claim.at);
  });

  it("poll moves a record to converting when the job reports swap", async () => {
    vi.useFakeTimers();
    await seed([awaitingDepositCryptoRecord], AWAITING_JOB_BLOB);
    const requests = useRequestsStore();
    await requests.reconcile("boot");
    expect(requests.get(AWAITING_REF)?.status).toEqual({ kind: "awaiting-deposit" });
    const readsAtBoot = host.blobReads();

    // The worker saw the deposit and started the swap between two ticks.
    const seenAt = FIXTURE_NOW + 3_000;
    await writeJobs({
      "dot-assethub:3": {
        ...AWAITING_JOB,
        phase: "swap",
        lastTickAt: seenAt + 1_000,
        state: { ...AWAITING_JOB.state, swapSubmitted: true, fundsSeenAt: seenAt },
      },
    });
    now = FIXTURE_NOW + JOB_POLL_MS;
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS);

    expect(host.blobReads()).toBe(readsAtBoot + 1);
    expect(requests.get(AWAITING_REF)).toMatchObject({
      status: { kind: "converting", at: now, step: "swap" },
      funded: seenAt,
      confirmedAt: now,
      witnesses: { worker: { known: true, phase: "swap", fundsSeenAt: seenAt, at: now } },
    });
    expect(requests.statuses[requestRefKey(AWAITING_REF)]).toEqual({
      kind: "converting",
      step: "swap",
    });
    // The deposit's first sighting is critical: on the host as soon as the tick lands it.
    expect(await stored(AWAITING_REF)).toMatchObject({
      status: { kind: "converting", at: now, step: "swap" },
      funded: seenAt,
    });
  });

  it("a job without a record creates a record with the job's amount and deadline", async () => {
    await seed(fixtureRecords);
    const requests = useRequestsStore();
    await requests.reconcile("boot");

    const job = fixtureWorkerJobs["dot-assethub:9"]!;
    const ref = requestRefOf("dot-assethub", 9);
    const record = requests.get(ref);
    expect(record).toMatchObject({
      schema: 2,
      kind: "top-up",
      ref,
      amountHuman: "12",
      chain: "AssetHub",
      asset: "DOT",
      startedAt: job.createdAt,
      depositAddress: job.burnerAddress,
      tradeN: 9,
      sourceId: "dot-assethub",
      route: "crypto",
      deadline: { depositExpiresAt: job.depositExpiresAt, source: "rail" },
      handoff: {
        label: "onramp:eph:dot-assethub:9",
        burnerAddress: job.burnerAddress,
        depositExpiresAt: job.depositExpiresAt,
        settleAmount: "12000000",
        underlyingAssetId: job.underlyingAssetId,
        peopleParaId: job.peopleParaId,
        assetHubGenesis: job.assetHubGenesis,
        peopleGenesis: job.peopleGenesis,
        remoteFeeBuffer: job.remoteFeeBuffer,
        keepNativeForFees: job.keepNativeForFees,
      },
      status: { kind: "awaiting-deposit" },
      rail: { provider: "manual", status: "waiting", stage: "waiting", updatedAt: job.createdAt },
      witnesses: {
        worker: { known: true, phase: "await-native", fundsSeenAt: null },
        clock: { at: FIXTURE_NOW },
      },
      confirmedAt: FIXTURE_NOW,
    });
    // Today's default crypto snapshot: no quote to size the ingress from.
    const profile = progressProviderForSource("dot-assethub").createProfile();
    const journeyMs =
      profile.expectedUserDelayMs +
      profile.stages.reduce((total, stage) => total + stage.nominalMs, 0);
    expect(record?.progress).toMatchObject({
      profile: { id: "chainflip" },
      stageTimestamps: {},
      preDetectionEstimateText: "≈10 min after your transfer",
      estimatedCompletionAt: job.createdAt + journeyMs,
    });
    expect(record).not.toHaveProperty("deposit");
    expect(record).not.toHaveProperty("refundAddress");
    expect(record).not.toHaveProperty("sourceAmount");

    // Written to the host and listed in the index, like a record the surface wrote itself.
    expect(await stored(ref)).toMatchObject({
      schema: 2,
      ref,
      amountHuman: "12",
      startedAt: job.createdAt,
    });
    const index = parseRequestIndex(await host.storage.read(REQUEST_INDEX_KEY));
    expect(index.some((listed) => sameRequestRef(listed, ref))).toBe(true);
    expect(requests.list.map((row) => requestRefKey(refOf(row)))).toEqual([
      "dot-assethub#9",
      "dot-assethub#4",
      "dot-assethub#3",
      "meld-card#2",
      "dot-assethub#2",
      "meld-card#1",
      "#7",
    ]);

    // The list renders it with generic labels: the source id's own chain and coin, no quote.
    const row = projectChainflipTopUps(requests.list, requests.statuses, FIXTURE_NOW).find(
      (topUp) => topUp.id === "crypto:dot-assethub#9",
    );
    expect(row).toMatchObject({
      amount: "12",
      route: "crypto",
      startedAt: job.createdAt,
      details: {
        network: { label: "AssetHub" },
        token: { label: "DOT" },
        depositAddress: job.burnerAddress,
        arrivalEstimate: "≈10 min after your transfer",
      },
    });
    expect(row).not.toHaveProperty("quote");
  });

  it("poll stops when every entry is settled", async () => {
    vi.useFakeTimers();
    await seed([awaitingDepositCryptoRecord], AWAITING_JOB_BLOB);
    const requests = useRequestsStore();
    await requests.reconcile("boot");
    await requests.flush();
    // Once the coalesced writes have landed, the job poll and the second hand are the only timers.
    expect(vi.getTimerCount()).toBe(2);
    const readsAtBoot = host.blobReads();

    // The worker claims the request before the next tick.
    const claimedAt = FIXTURE_NOW + 4_000;
    await writeJobs({
      "dot-assethub:3": {
        ...AWAITING_JOB,
        phase: "done",
        done: true,
        lastTickAt: claimedAt,
        state: {
          ...AWAITING_JOB.state,
          swapSubmitted: true,
          xcmSubmitted: true,
          fundsSeenAt: FIXTURE_NOW + 2_000,
        },
        claim: { phase: "claimed", amount: "25250000", at: claimedAt, attempts: 1 },
      },
    });
    now = FIXTURE_NOW + JOB_POLL_MS;
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    expect(host.blobReads()).toBe(readsAtBoot + 1);
    expect(requests.get(AWAITING_REF)).toMatchObject({
      status: { kind: "settled", at: claimedAt },
      claimed: "25250000",
    });
    await requests.flush();
    expect(vi.getTimerCount()).toBe(0);

    // Nothing left at rank 0–3: no tick reads the blob again.
    now += 2 * JOB_POLL_MS;
    await vi.advanceTimersByTimeAsync(2 * JOB_POLL_MS);
    expect(host.blobReads()).toBe(readsAtBoot + 1);

    // A reconcile over settled entries reads the blob once and leaves the poll stopped.
    await requests.reconcile("refresh");
    await requests.flush();
    expect(host.blobReads()).toBe(readsAtBoot + 2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("known:false leaves the record unchanged and records the witness", async () => {
    // The blob holds no job for the submitted card request.
    await seed(fixtureRecords);
    const requests = useRequestsStore();
    await requests.reconcile("boot");

    const ref = refOf(submittedCardRecord);
    // The witness lives in memory only: no rev bump, nothing pending, nothing written.
    expect(requests.get(ref)).toEqual({
      ...migrated(submittedCardRecord, ref),
      witnesses: { worker: { known: false, at: FIXTURE_NOW }, clock: { at: FIXTURE_NOW } },
    });
    expect(requests.get(ref)?.rev).toBe(0);
    expect(requests.get(ref)).not.toHaveProperty("confirmedAt");
    expect(requests.entries[requestRefKey(ref)]?.pendingWrite).toBe(false);
    expect(requests.statuses[requestRefKey(ref)]).toBeUndefined();
    expect(await stored(ref)).toEqual(submittedCardRecord);
    await requests.flush();
    expect(await stored(ref)).toEqual(submittedCardRecord);
  });
});
