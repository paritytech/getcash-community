// The foreground through the store: the mock world's own record, the computed views over the
// record on screen, the confirmed cancel and retry, the deposit-expiry clock, and a preview deck
// that writes state only through observations.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { PaymentState } from "@getsome/core";
import type { FundingProgressSnapshot } from "../app/funding/progress";
import { migrateRecord } from "../app/funding/requests/migrate";
import {
  CANCEL_CONFIRM_MS,
  DEPOSIT_EXPIRED_REASON,
  setRequestsClock,
  type Observation,
  type RequestRecord,
} from "../app/funding/requests/model";
import {
  createMemoryKeyedStorage,
  setMirrorStorage,
  setRecordStorage,
  WORKER_JOBS_KEY,
  type KeyedStorage,
} from "../app/funding/requests/storage";
import { useRequestsStore } from "../app/stores/requests";
import { useSessionStore, type ActiveFlowRecord } from "../app/stores/session";
import { requestRefKey, requestRefOf, type RequestRef } from "../app/utils/request-index";
import { awaitingDepositCryptoRecord, FIXTURE_NOW } from "./fixtures/requests";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Minutes after the fixture instant. */
const at = (minutes: number) => FIXTURE_NOW + minutes * MINUTE;

const refOf = (record: ActiveFlowRecord): RequestRef =>
  requestRefOf(record.sourceId, record.tradeN!);
const AWAITING_REF = refOf(awaitingDepositCryptoRecord);
const AWAITING_JOB_ID = "dot-assethub:3";

const migrated = (record: ActiveFlowRecord): RequestRecord => {
  const result = migrateRecord(record, refOf(record), FIXTURE_NOW);
  if (result === null) throw new Error("fixture did not migrate");
  return result;
};

const DEPOSIT = {
  address: "14uAyRtbeRsrgERPLETm72yFPKW3oi3m4RX93arNwGQhsduC",
  amount: 2_934_713_048n,
  formatted: "0.29",
  assetSymbol: "PAS",
  expiresAt: 0,
};

const coreAwaitingDeposit = (time: number): Observation => ({
  source: "core",
  at: time,
  state: {
    phase: "awaiting-deposit",
    sourceId: "dot-assethub",
    quote: null,
    deposit: DEPOSIT,
  } as PaymentState,
});
const coreDone = (time: number): Observation => ({
  source: "core",
  at: time,
  state: {
    phase: "done",
    sourceId: "dot-assethub",
    result: { id: "test", sourceId: "dot-assethub" },
  } as PaymentState,
});
const workerSwap = (time: number): Observation => ({
  source: "worker",
  at: time,
  job: { phase: "swap", done: false, fundsSeenAt: time, lastTickAt: time, claim: null },
});
const workerDone = (time: number, fundsSeenAt: number): Observation => ({
  source: "worker",
  at: time,
  job: { phase: "done", done: true, fundsSeenAt, lastTickAt: time, claim: null },
});
const workerFailed = (time: number, fundsSeenAt: number): Observation => ({
  source: "worker",
  at: time,
  job: {
    phase: "failed",
    done: false,
    failure: "shortfall",
    lastError: "shortfall: the deposit is below the swap minimum",
    fundsSeenAt,
    lastTickAt: time,
    claim: null,
  },
});

/** The fields of a progress snapshot the views and the journey read. */
function progressOf(snapshot: FundingProgressSnapshot | undefined) {
  if (snapshot === undefined) return undefined;
  const { confirmedStageKey, latestRouteStatus, detectedAt, stageTimestamps, settledAt } = snapshot;
  return { confirmedStageKey, latestRouteStatus, detectedAt, stageTimestamps, settledAt };
}

const waitFor = async (predicate: () => boolean, ms: number) => {
  const until = Date.now() + ms;
  while (!predicate() && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
};

let host: KeyedStorage;

describe("requests store: foreground, clock and user actions", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    host = createMemoryKeyedStorage();
    setRecordStorage(host);
    setMirrorStorage(null);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    const requests = useRequestsStore();
    requests.leave();
    requests.stopJobPoll();
    await requests.flush();
    vi.useRealTimers();
    vi.restoreAllMocks();
    setRequestsClock(Date.now);
  });

  // The mock world's funded gate polls in seconds; this test runs on real time.
  it(
    "mock world start, deposit and claim settle the foreground record",
    { timeout: 30_000 },
    async () => {
      const session = useSessionStore();
      const requests = useRequestsStore();
      session.setAmount("1");
      await session.fetchQuote("Bitcoin", "BTC");
      await session.start();

      const ref = requestRefOf("btc", 1);
      expect(requests.foregroundRecord?.ref).toEqual(ref);
      expect(requests.get(ref)?.status.kind).toBe("awaiting-deposit");
      expect(requests.phase).toBe("awaiting-deposit");
      expect(requests.fundsSeen).toBe(false);

      session.simulateDeposit();
      await waitFor(() => requests.get(ref)?.status.kind === "claiming", 15_000);
      expect(requests.get(ref)?.status.kind).toBe("claiming");
      expect(requests.phase).toBe("working");
      expect(requests.claiming).toBe(true);

      session.approveClaim();
      await waitFor(() => requests.get(ref)?.status.kind === "settled", 10_000);
      expect(requests.get(ref)?.status.kind).toBe("settled");
      expect(requests.phase).toBe("done");
      expect(requests.journeyDone).toBe(5);
      expect(requests.foregroundProgress?.snapshot.confirmedStageKey).toBe("cash-top-up");
    },
  );

  it("computed views match the milestone-1 table for a core-driven sequence", async () => {
    setRequestsClock(() => FIXTURE_NOW);
    const requests = useRequestsStore();
    const record = migrated(awaitingDepositCryptoRecord);
    const { startedAt } = record;
    await requests.create(AWAITING_REF, record);
    requests.setForeground(AWAITING_REF);
    const views = () => ({
      phase: requests.phase,
      fundsSeen: requests.fundsSeen,
      fundingStep: requests.fundingStep,
      claiming: requests.claiming,
      journeyDone: requests.journeyDone,
      milestones: requests.milestones,
      progress: progressOf(requests.foregroundProgress?.snapshot),
    });

    await requests.observe(AWAITING_REF, coreAwaitingDeposit(at(1)));
    expect(views()).toEqual({
      phase: "awaiting-deposit",
      fundsSeen: false,
      fundingStep: null,
      claiming: false,
      journeyDone: 1,
      milestones: { 1: startedAt },
      progress: {
        confirmedStageKey: undefined,
        latestRouteStatus: "waiting",
        detectedAt: undefined,
        stageTimestamps: {},
        settledAt: undefined,
      },
    });

    await requests.observe(AWAITING_REF, workerSwap(at(2)));
    expect(views()).toEqual({
      phase: "awaiting-deposit",
      fundsSeen: true,
      fundingStep: "swap",
      claiming: false,
      journeyDone: 3,
      milestones: { 1: startedAt, 2: at(2), 4: at(2) },
      progress: {
        confirmedStageKey: "cash-conversion",
        latestRouteStatus: "complete",
        detectedAt: at(2),
        stageTimestamps: { "cash-conversion": at(2) },
        settledAt: undefined,
      },
    });

    await requests.observe(AWAITING_REF, workerDone(at(3), at(2)));
    expect(views()).toEqual({
      phase: "working",
      fundsSeen: true,
      fundingStep: "done",
      claiming: true,
      journeyDone: 4,
      milestones: { 1: startedAt, 2: at(2), 4: at(2) },
      progress: {
        confirmedStageKey: "cash-top-up",
        latestRouteStatus: "complete",
        detectedAt: at(2),
        stageTimestamps: { "cash-conversion": at(2), "cash-top-up": at(3) },
        settledAt: undefined,
      },
    });
    expect(requests.claimStage).toBe("prompted");

    await requests.observe(AWAITING_REF, coreDone(at(4)));
    expect(views()).toEqual({
      phase: "done",
      fundsSeen: true,
      fundingStep: "done",
      claiming: false,
      journeyDone: 5,
      milestones: { 1: startedAt, 2: at(2), 4: at(2), 5: at(4) },
      progress: {
        confirmedStageKey: "cash-top-up",
        latestRouteStatus: "complete",
        detectedAt: at(2),
        stageTimestamps: { "cash-conversion": at(2), "cash-top-up": at(3) },
        settledAt: at(4),
      },
    });
    expect(requests.claimStage).toBeNull();
    expect(requests.fundingError).toBeNull();
  });

  it("cancel refuses on funds in the burner read", async () => {
    setRequestsClock(() => FIXTURE_NOW);
    const requests = useRequestsStore();
    const session = useSessionStore();
    await requests.create(AWAITING_REF, migrated(awaitingDepositCryptoRecord));
    requests.setForeground(AWAITING_REF);

    const verdict = await requests.cancel(AWAITING_REF, { readBurner: async () => 250_000_000n });
    expect(verdict).toBe("refused");
    expect(requests.get(AWAITING_REF)).toMatchObject({
      status: {
        kind: "deposit-seen",
        at: FIXTURE_NOW,
        assurance: "provisional",
        via: "pre-cancel",
      },
      funded: FIXTURE_NOW,
      witnesses: { chain: { best: { burnerNative: "250000000", at: FIXTURE_NOW } } },
    });
    // The refused cancel latches the deposit as seen, which hides the cancel button.
    expect(requests.fundsSeen).toBe(true);
    expect(session.canSkipDeposit).toBe(false);
  });

  it("cancel returns unconfirmed when the reads time out", async () => {
    vi.useFakeTimers();
    setRequestsClock(() => FIXTURE_NOW);
    const requests = useRequestsStore();
    await requests.create(AWAITING_REF, migrated(awaitingDepositCryptoRecord));

    const verdict = requests.cancel(AWAITING_REF, { readBurner: () => new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(CANCEL_CONFIRM_MS - 1);
    let settled = false;
    void verdict.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await verdict).toBe("unconfirmed");
    expect(console.warn).toHaveBeenCalledWith(
      "[requests] cancel unconfirmed: the burner read did not answer in time",
    );
    // Nothing was observed: the record still awaits its deposit, and no read was recorded.
    expect(requests.get(AWAITING_REF)).toMatchObject({
      rev: 0,
      status: { kind: "awaiting-deposit" },
      witnesses: {},
    });
  });

  it("cancel proceeds and the record becomes cancelled", async () => {
    setRequestsClock(() => FIXTURE_NOW);
    const requests = useRequestsStore();
    await requests.create(AWAITING_REF, migrated(awaitingDepositCryptoRecord));
    // A job still waiting for the deposit is not a money observation.
    await host.write(
      WORKER_JOBS_KEY,
      JSON.stringify({
        [AWAITING_JOB_ID]: {
          phase: "await-native",
          done: false,
          lastTickAt: FIXTURE_NOW,
          state: { fundsSeenAt: null },
        },
      }),
    );

    expect(await requests.cancel(AWAITING_REF, { readBurner: async () => 0n })).toBe("ok");
    expect(requests.get(AWAITING_REF)?.status).toEqual({ kind: "awaiting-deposit" });

    await requests.observe(AWAITING_REF, {
      source: "user",
      at: at(1),
      event: "cancelled",
      depositExpiresAt: awaitingDepositCryptoRecord.depositExpiresAt!,
    });
    expect(requests.get(AWAITING_REF)).toMatchObject({
      rev: 1,
      status: { kind: "cancelled", at: at(1) },
      cancelledAt: at(1),
      depositExpiresAt: awaitingDepositCryptoRecord.depositExpiresAt,
    });
    // Cancelled records stay in memory (the sweep reads them) and leave the list.
    expect(requests.entries[requestRefKey(AWAITING_REF)]).toBeDefined();
    expect(requests.openRecords).toEqual([]);
  });

  it("retry is a no-op without a recoverable failure confirmed by the job", async () => {
    setRequestsClock(() => FIXTURE_NOW);
    const requests = useRequestsStore();
    await requests.create(AWAITING_REF, migrated(awaitingDepositCryptoRecord));

    // Not failed: nothing to retry.
    expect(await requests.retry(AWAITING_REF)).toBe(false);
    expect(console.warn).not.toHaveBeenCalled();

    // Recoverably failed in memory, but the worker's blob has no job to confirm it.
    await requests.observe(AWAITING_REF, workerSwap(at(1)));
    await requests.observe(AWAITING_REF, workerFailed(at(2), at(1)));
    expect(requests.get(AWAITING_REF)?.status).toEqual({
      kind: "failed",
      at: at(2),
      recoverable: true,
    });
    expect(await requests.retry(AWAITING_REF)).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(
      "[requests] retry ignored: the failure is not confirmed as recoverable",
    );
    expect(requests.get(AWAITING_REF)?.status.kind).toBe("failed");

    // The job confirms the shortfall: the retry moves the record back into the conversion.
    await host.write(
      WORKER_JOBS_KEY,
      JSON.stringify({
        [AWAITING_JOB_ID]: {
          phase: "failed",
          failure: "shortfall",
          done: false,
          lastTickAt: at(2),
          state: { fundsSeenAt: at(1) },
        },
      }),
    );
    expect(await requests.retry(AWAITING_REF)).toBe(true);
    expect(requests.get(AWAITING_REF)).toMatchObject({
      status: { kind: "converting", at: FIXTURE_NOW, step: "swap" },
    });
    expect(requests.get(AWAITING_REF)?.failure).toBeUndefined();
  });

  it("clock expires a foreground record past its deadline", async () => {
    vi.useFakeTimers();
    // Two days on: the channel's 24-hour window closed a day ago.
    const now = FIXTURE_NOW + 2 * DAY;
    setRequestsClock(() => now);
    const requests = useRequestsStore();
    await requests.create(AWAITING_REF, migrated(awaitingDepositCryptoRecord));
    expect(requests.get(AWAITING_REF)?.status).toEqual({ kind: "awaiting-deposit" });

    requests.setForeground(AWAITING_REF);
    expect(requests.phase).toBe("awaiting-deposit");
    expect(requests.fundingError).toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(requests.get(AWAITING_REF)).toMatchObject({
      rev: 1,
      status: { kind: "expired", at: now },
      failureReason: DEPOSIT_EXPIRED_REASON,
      witnesses: { clock: { at: now } },
    });
    expect(requests.phase).toBe("failed");
    expect(requests.fundingError).toBe(DEPOSIT_EXPIRED_REASON);
    expect(requests.foregroundProgress?.snapshot.failedAt).toBe(now);
  });

  it("preview deck writes no session refs", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../app/utils/dev-preview.ts", import.meta.url)),
      "utf8",
    );
    const written = new Set<string>();
    for (const match of source.matchAll(/\b(?:session|s)\.([a-zA-Z]+) = /g)) {
      written.add(match[1]!);
    }
    const allowed = new Set(["quoted", "method", "mock", "faucetState", "resuming"]);
    expect([...written].filter((name) => !allowed.has(name))).toEqual([]);
  });
});
