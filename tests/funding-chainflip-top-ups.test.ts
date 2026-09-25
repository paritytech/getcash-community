import { describe, expect, it } from "vitest";
import { chainflipRequestRef, projectChainflipTopUps } from "../app/funding/chainflip-top-ups";
import { chainflipProgressProvider, createFundingProgressSnapshot } from "../app/funding/progress";
import { migrateRecord } from "../app/funding/requests/migrate";
import type { Observation, RequestRecord, WorkerJobView } from "../app/funding/requests/model";
import { reduce } from "../app/funding/requests/reducer";
import type { ActiveFlowRecord } from "../app/stores/session";
import { requestRefOf } from "../app/utils/request-index";

type Stored = Partial<ActiveFlowRecord> & {
  tradeN: number;
  amountHuman: string;
  startedAt: number;
};

/** A stored record as the store reads it: migrated under its own key at `now`. */
function record(stored: Stored, now: number): RequestRecord {
  const migrated = migrateRecord(stored, requestRefOf(stored.sourceId, stored.tradeN), now);
  if (migrated === null) throw new Error("record did not migrate");
  return migrated;
}

/** The worker's job at `phase`, its deposit in hand since `at`. */
const worker = (at: number, phase: string, job: Partial<WorkerJobView> = {}): Observation => ({
  source: "worker",
  at,
  job: { phase, done: phase === "done", fundsSeenAt: at, lastTickAt: at, claim: null, ...job },
});

describe("Chainflip top-up adapter", () => {
  it("projects unfunded and funded records into active shell states", () => {
    const now = 1_000;
    const records = [
      record({ tradeN: 2, amountHuman: "25", startedAt: 200 }, now), // pre-source-aware: bare key
      record(
        { tradeN: 3, amountHuman: "50", startedAt: 300, funded: 350, sourceId: "dot-assethub" },
        now,
      ),
    ];

    const topUps = projectChainflipTopUps(records, now);

    expect(topUps[0]).toMatchObject({
      id: "crypto:#2",
      amount: "25",
      route: "crypto",
      startedAt: 200,
      progress: {
        estimateText: "≈10 min after your transfer",
        view: { kind: "waiting", label: "Waiting for your transfer" },
      },
      state: { kind: "awaiting-transfer", status: "Waiting for your transfer" },
    });
    expect(topUps[1]).toMatchObject({
      id: "crypto:dot-assethub#3",
      amount: "50",
      route: "crypto",
      startedAt: 300,
      progress: {
        detectedAt: 350,
        stageTimestamps: { "cash-conversion": 350 },
        view: { kind: "active", activeStageKey: "cash-conversion" },
      },
      state: { kind: "finishing", status: "Converting to $CASH" },
    });
  });

  it("reads the worker's claim ahead of the durable funded marker", () => {
    const funded = record(
      { tradeN: 4, amountHuman: "20", startedAt: 400, sourceId: "dot-assethub" },
      500,
    );
    const claimed = reduce(
      funded,
      worker(450, "done", { claim: { phase: "claimed", amount: "20250000", at: 450 } }),
    );

    expect(projectChainflipTopUps([claimed], 500)[0]).toMatchObject({
      progress: { view: { kind: "settled", label: "Ready to spend" }, settledAt: 450 },
      state: { kind: "settled", at: 450, creditedAmount: "20.25" },
    });
  });

  it("projects failed and settled requests as history records", () => {
    const now = 900;
    const swapping = reduce(
      record({ tradeN: 5, amountHuman: "40", startedAt: 500 }, now),
      worker(600, "swap"),
    );
    const failed = reduce(
      swapping,
      worker(now, "failed", { failure: "shortfall", lastError: "Deposit expired" }),
    );
    const settled = record(
      {
        tradeN: 6,
        amountHuman: "100",
        startedAt: 600,
        chain: "Bitcoin",
        asset: "BTC",
        depositAddress: "bc1q-saved-deposit",
        settledAt: 800,
        claimed: "100250000",
      },
      now,
    );
    const records = [failed, settled];

    // With no persisted failure time, the failure is dated at the worker's report.
    expect(projectChainflipTopUps(records, now).map(({ state }) => state)).toEqual([
      { kind: "failed", at: now, reason: "Deposit expired" },
      { kind: "settled", at: 800, creditedAmount: "100.25" },
    ]);
    // A direct deposit names no provider; the record's network and token are what the buyer saw.
    expect(projectChainflipTopUps(records, now)[1]?.details).toEqual({
      network: { label: "Bitcoin", icon: "/icons/bitcoin.svg" },
      token: { label: "BTC", icon: "/icons/bitcoin.svg" },
      depositAddress: "bc1q-saved-deposit",
      arrivalEstimate: "≈10 min after your transfer",
    });
  });

  it("projects a Polkadot request under its own source, with the token it was paid in", () => {
    const usdc = record(
      {
        tradeN: 9,
        amountHuman: "50",
        startedAt: 100,
        sourceId: "usdc-assethub",
        chain: "Polkadot",
        asset: "USDC",
        depositAddress: "5BurnerOnAssetHub",
      },
      200,
    );
    const [row] = projectChainflipTopUps([usdc], 200);
    expect(row?.id).toBe("crypto:usdc-assethub#9");
    expect(row?.request).toEqual({ sourceId: "usdc-assethub", tradeN: 9 });
    expect(row?.details).toEqual({
      network: { label: "Polkadot", icon: "/icons/polkadot.svg" },
      token: { label: "USDC", icon: "/icons/usdc.svg" },
      depositAddress: "5BurnerOnAssetHub",
      arrivalEstimate: "≈10 min after your transfer",
    });
    expect(chainflipRequestRef("crypto:usdc-assethub#3")).toEqual({
      sourceId: "usdc-assethub",
      tradeN: 3,
    });
  });

  it("keeps a persisted failure time over the observation time", () => {
    const failedAt = 700;
    const failed = record(
      {
        tradeN: 8,
        amountHuman: "40",
        startedAt: 500,
        failureReason: "Deposit expired",
        progress: createFundingProgressSnapshot(chainflipProgressProvider.createProfile(), {
          failedAt,
        }),
      },
      900,
    );

    expect(projectChainflipTopUps([failed], 900)[0]?.state).toEqual({
      kind: "failed",
      at: failedAt,
      reason: "Deposit expired",
    });
  });

  it("ignores incomplete records and rejects foreign identifiers", () => {
    const incomplete = migrateRecord({ startedAt: 100 }, requestRefOf(undefined, 1), 100);
    expect(incomplete).toBeNull();
    expect(projectChainflipTopUps(incomplete === null ? [] : [incomplete])).toEqual([]);
    expect(chainflipRequestRef("crypto:dot-assethub#17")).toEqual({
      sourceId: "dot-assethub",
      tradeN: 17,
    });
    expect(chainflipRequestRef("crypto:#17")).toEqual({ tradeN: 17 });
    expect(chainflipRequestRef("bank:meld-bank#17")).toBeNull();
    expect(chainflipRequestRef("crypto:meld-card#17")).toBeNull(); // another rail's request
    expect(chainflipRequestRef("crypto:17")).toBeNull();
    expect(chainflipRequestRef("crypto:#not-a-number")).toBeNull();
  });

  it("leaves another rail's records to that rail's adapter", () => {
    // The trade counter is per source: meld-card #7 and dot-assethub #7 are different purchases.
    const records = [
      record({ tradeN: 7, amountHuman: "25", startedAt: 100, sourceId: "meld-card" }, 200),
      record({ tradeN: 7, amountHuman: "30", startedAt: 110, sourceId: "dot-assethub" }, 200),
    ];
    expect(projectChainflipTopUps(records).map(({ id }) => id)).toEqual(["crypto:dot-assethub#7"]);
  });

  it("keeps route details available for legacy records", () => {
    const legacy = record({ tradeN: 7, amountHuman: "25", startedAt: 100 }, 200);
    expect(projectChainflipTopUps([legacy])[0]?.details).toEqual({
      arrivalEstimate: "≈10 min after your transfer",
    });
  });
});
