// The hand-off step: a reconcile hands the worker every open request it lost, from the record's
// stored payload, and builds a world only for a record that never stored one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { migrateRecord } from "../app/funding/requests/migrate";
import {
  DEFAULT_DEPOSIT_WINDOW_MS,
  setRequestsClock,
  WORKER_READY_MS,
  type RequestRecord,
  type WorkerHandoffPayload,
} from "../app/funding/requests/model";
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
  requestRefKey,
  requestRefOf,
  serializeRequestIndex,
  type RequestRef,
} from "../app/utils/request-index";
import {
  awaitingDepositCryptoRecord,
  FIXTURE_NOW,
  fixtureWorkerJobs,
  fundedCryptoRecord,
  submittedCardRecord,
  type WorkerJobRecord,
} from "./fixtures/requests";

// The hand-off step runs hosted only. Outside the Polkadot App the worker manager and the hosted
// world are stand-ins: the manager records its calls, the world factory counts its builds.
const { worker, manager, worlds, createWorld, LEGACY_HANDOFF } = vi.hoisted(() => {
  const worker = {
    available: true,
    /** How many times the driver asked for the heartbeat. */
    checks: 0,
    calls: [] as { api: string; payload: unknown }[],
  };
  const manager = {
    isAvailable: () => {
      worker.checks += 1;
      return worker.available;
    },
    call: async (api: string, payload?: unknown) => {
      worker.calls.push({ api, payload });
    },
    dispose() {},
  };
  /** What the one world a legacy record builds hands over. */
  const LEGACY_HANDOFF = {
    label: "onramp:eph:dot-assethub:3",
    burnerAddress: "14uAyRtbeRsrgERPLETm72yFPKW3oi3m4RX93arNwGQhsduC",
    depositExpiresAt: 0,
    settleAmount: "25000000",
    underlyingAssetId: 1337,
    peopleParaId: 1004,
    assetHubGenesis: `0x${"aa".repeat(32)}`,
    peopleGenesis: `0x${"bb".repeat(32)}`,
    remoteFeeBuffer: "500000000",
    keepNativeForFees: "100000000",
  };
  const worlds = {
    builds: [] as { amount: bigint; tradeN?: number; sourceId?: string }[],
    disposed: 0,
  };
  const createWorld = async (args: { amount: bigint; tradeN?: number; sourceId?: string }) => {
    worlds.builds.push(args);
    return {
      handoffPayload: async () => LEGACY_HANDOFF,
      dispose() {
        worlds.disposed += 1;
      },
      session: { peek: () => null },
    };
  };
  return { worker, manager, worlds, createWorld, LEGACY_HANDOFF };
});
vi.mock("../lib/host-account", () => ({ isHosted: () => true }));
vi.mock("../lib/worker-rpc", () => ({ getStorageWorkerManager: () => manager }));
vi.mock("../lib/coinage-live", () => ({
  createHostedCoinageWorld: createWorld,
  ensureChainSubmitGrant: async () => {},
}));

const MINUTE = 60_000;
const NOT_RUNNING = "the funding worker is not running on this host; the purchase cannot start";

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

/** A `startFunding` call as the manager records it. */
const startFunding = (sessionId: string, payload: WorkerHandoffPayload) => ({
  api: "startFunding",
  payload: { sessionId, ...payload },
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

const AWAITING_REF = refOf(awaitingDepositCryptoRecord);
const FUNDED_REF = refOf(fundedCryptoRecord);
const SUBMITTED_REF = refOf(submittedCardRecord);
const AWAITING_JOB = fixtureWorkerJobs["dot-assethub:3"]!;
const AWAITING_HANDOFF = handoffOf(AWAITING_JOB);
const FUNDED_HANDOFF = handoffOf(fixtureWorkerJobs["dot-assethub:4"]!);
/** The worker's job for the submitted card request, as armed at its start. */
const CARD_JOB: WorkerJobRecord = {
  ...AWAITING_JOB,
  sessionId: "meld-card:2",
  label: "onramp:eph:meld-card:2",
  settleAmount: "50000000",
  depositExpiresAt: submittedCardRecord.startedAt + 30 * MINUTE,
  createdAt: submittedCardRecord.startedAt,
  armedAt: submittedCardRecord.startedAt,
};
const CARD_HANDOFF = handoffOf(CARD_JOB);
/** The same job once its window closed before the funds landed. */
const EXPIRED_CARD_JOB: WorkerJobRecord = {
  ...CARD_JOB,
  phase: "failed",
  failure: "expired",
  lastTickAt: FIXTURE_NOW - MINUTE,
};

let host: KeyedStorage;

/** Stores the records as today's writers do and lists them in the index. */
async function seed(records: readonly ActiveFlowRecord[]): Promise<void> {
  for (const record of records) {
    await host.write(requestKey(refOf(record)), JSON.stringify(record));
  }
  await host.write(REQUEST_INDEX_KEY, serializeRequestIndex(records.map(refOf)));
}

/** Replaces the worker's blob, as the worker does on its own tick. */
function writeJobs(jobs: Record<string, WorkerJobRecord>): Promise<void> {
  return host.write(WORKER_JOBS_KEY, JSON.stringify(jobs));
}

async function stored(ref: RequestRef): Promise<Record<string, unknown> | null> {
  const raw = await host.read(requestKey(ref));
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

const realSetTimeout = setTimeout;
/** Yields to the real event loop until the driver asks for the heartbeat: the store reaches its
 *  wait through dynamic imports, which the fake clock does not cover. */
async function untilHeartbeatWait(): Promise<void> {
  while (worker.checks === 0) await new Promise((resolve) => realSetTimeout(resolve, 0));
}

describe("requests store: the hand-off step", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    host = createMemoryKeyedStorage();
    setRecordStorage(host);
    setMirrorStorage(fakeWebStorage());
    setRequestsClock(() => FIXTURE_NOW);
    worker.available = true;
    worker.checks = 0;
    worker.calls.length = 0;
    worlds.builds.length = 0;
    worlds.disposed = 0;
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

  it("re-sends the stored payload for a job the worker does not know", async () => {
    const requests = useRequestsStore();
    // Two open requests off screen, each with the hand-off it started with, and the one on
    // screen, whose own world hands it over. The worker's blob has none of them.
    await requests.create(AWAITING_REF, {
      ...migrated(awaitingDepositCryptoRecord),
      handoff: AWAITING_HANDOFF,
    });
    await requests.create(FUNDED_REF, { ...migrated(fundedCryptoRecord), handoff: FUNDED_HANDOFF });
    await requests.create(SUBMITTED_REF, {
      ...migrated(submittedCardRecord),
      handoff: CARD_HANDOFF,
    });
    requests.setForeground(SUBMITTED_REF);

    await requests.reconcile("boot");

    expect(worker.calls).toEqual([
      startFunding("dot-assethub:3", AWAITING_HANDOFF),
      startFunding("dot-assethub:4", FUNDED_HANDOFF),
    ]);
    expect(worlds.builds).toEqual([]);
    // A re-send is not an observation: the record waits for the next read of the worker's jobs.
    expect(requests.get(AWAITING_REF)).toMatchObject({
      rev: 0,
      status: { kind: "awaiting-deposit" },
      witnesses: { worker: { known: false, at: FIXTURE_NOW } },
    });
    expect(requests.entries[requestRefKey(AWAITING_REF)]).not.toHaveProperty("handoffError");
  });

  it("does not send for a known job", async () => {
    const requests = useRequestsStore();
    await requests.create(AWAITING_REF, {
      ...migrated(awaitingDepositCryptoRecord),
      handoff: AWAITING_HANDOFF,
    });
    await writeJobs({ "dot-assethub:3": AWAITING_JOB });

    await requests.reconcile("boot");

    expect(worker.calls).toEqual([]);
    expect(worlds.builds).toEqual([]);
    expect(requests.get(AWAITING_REF)?.witnesses.worker).toMatchObject({
      known: true,
      phase: "await-native",
    });
  });

  it("re-sends with a fresh deadline for an expired job whose rail says paid", async () => {
    const requests = useRequestsStore();
    const paidAt = submittedCardRecord.meldSubmittedAt!;
    // The provider reported the payment, so the request no longer expires; the worker's own
    // window closed before the funds landed.
    await requests.create(SUBMITTED_REF, {
      ...migrated(submittedCardRecord),
      handoff: CARD_HANDOFF,
      status: { kind: "deposit-seen", at: paidAt, assurance: "provisional", via: "rail" },
      rail: { provider: "meld", status: "receiving", stage: "received", updatedAt: paidAt },
    });
    await writeJobs({ "meld-card:2": EXPIRED_CARD_JOB });

    await requests.reconcile("boot");

    expect(worker.calls).toEqual([
      startFunding("meld-card:2", {
        ...CARD_HANDOFF,
        depositExpiresAt: FIXTURE_NOW + DEFAULT_DEPOSIT_WINDOW_MS,
      }),
    ]);
    // The stored hand-off keeps its own deadline; the record waits for the worker's next verdict.
    expect(requests.get(SUBMITTED_REF)).toMatchObject({
      rev: 0,
      status: { kind: "deposit-seen" },
      handoff: CARD_HANDOFF,
      witnesses: { worker: { known: true, phase: "failed", failure: "expired" } },
    });
  });

  it("builds one world for a legacy record, persists the payload, disposes the world", async () => {
    // Stored as today's record: no hand-off on it, and no job in the worker's blob.
    await seed([awaitingDepositCryptoRecord]);
    const requests = useRequestsStore();

    await requests.reconcile("boot");

    expect(worlds.builds).toEqual([{ amount: 25_000_000n, tradeN: 3, sourceId: "dot-assethub" }]);
    expect(worlds.disposed).toBe(1);
    expect(worker.calls).toEqual([startFunding("dot-assethub:3", LEGACY_HANDOFF)]);
    // The payload is on the record with a rev bump, and reaches the host with the coalesced write.
    expect(requests.get(AWAITING_REF)).toMatchObject({ rev: 1, handoff: LEGACY_HANDOFF });
    await requests.flush();
    expect(await stored(AWAITING_REF)).toMatchObject({
      schema: 2,
      rev: 1,
      handoff: LEGACY_HANDOFF,
    });
  });

  it("waits for the heartbeat and gives up after WORKER_READY_MS", async () => {
    vi.useFakeTimers();
    worker.available = false;
    const requests = useRequestsStore();
    await requests.create(AWAITING_REF, {
      ...migrated(awaitingDepositCryptoRecord),
      handoff: AWAITING_HANDOFF,
    });

    const reconciled = requests.reconcile("boot");
    await untilHeartbeatWait();
    await vi.advanceTimersByTimeAsync(WORKER_READY_MS + 500);
    await reconciled;

    expect(worker.calls).toEqual([]);
    expect(requests.entries[requestRefKey(AWAITING_REF)]?.handoffError).toBe(NOT_RUNNING);
    // The failure is the entry's note alone: the record is untouched, and the next reconcile
    // tries again.
    expect(requests.get(AWAITING_REF)).toMatchObject({
      rev: 0,
      status: { kind: "awaiting-deposit" },
      witnesses: { worker: { known: false, at: FIXTURE_NOW } },
    });
  });

  it("waits for the heartbeat once per pass when the worker is down", async () => {
    vi.useFakeTimers();
    worker.available = false;
    const requests = useRequestsStore();
    await requests.create(AWAITING_REF, {
      ...migrated(awaitingDepositCryptoRecord),
      handoff: AWAITING_HANDOFF,
    });
    await requests.create(FUNDED_REF, {
      ...migrated(fundedCryptoRecord),
      handoff: FUNDED_HANDOFF,
    });

    const reconciled = requests.reconcile("refresh");
    await untilHeartbeatWait();
    // One bound covers both records: the pass is done after a single wait, not one per record.
    await vi.advanceTimersByTimeAsync(WORKER_READY_MS + 500);
    const doneAfterOneWait = await Promise.race([
      reconciled.then(() => true),
      new Promise<boolean>((resolve) => realSetTimeout(() => resolve(false), 0)),
    ]);
    expect(doneAfterOneWait).toBe(true);

    expect(worker.calls).toEqual([]);
    expect(requests.entries[requestRefKey(AWAITING_REF)]?.handoffError).toBe(NOT_RUNNING);
    expect(requests.entries[requestRefKey(FUNDED_REF)]?.handoffError).toBe(NOT_RUNNING);
    const skipped = vi
      .mocked(console.warn)
      .mock.calls.filter(([line]) => String(line).startsWith("[requests] worker not running"));
    expect(skipped).toEqual([
      ["[requests] worker not running; 2 hand-off(s) wait for the next pass"],
    ]);
  });
});
