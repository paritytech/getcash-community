import { describe, expect, it } from "vitest";
import { chainflipRequestRef, projectChainflipTopUps } from "../app/funding/chainflip-top-ups";
import { chainflipProgressProvider, createFundingProgressSnapshot } from "../app/funding/progress";
import type { RequestStatus } from "../app/stores/session";

describe("Chainflip top-up adapter", () => {
  it("projects unfunded and funded records into active shell states", () => {
    const records = [
      { tradeN: 2, amountHuman: "25", startedAt: 200 }, // pre-source-aware: bare key
      { tradeN: 3, amountHuman: "50", startedAt: 300, funded: 350, sourceId: "dot-assethub" },
    ];

    const topUps = projectChainflipTopUps(records, {}, 1_000);

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
      state: { kind: "finishing", status: "Converting to CASH" },
    });
  });

  it("uses live statuses ahead of the durable funded marker", () => {
    const records = [{ tradeN: 4, amountHuman: "20", startedAt: 400, sourceId: "dot-assethub" }];
    const statuses = {
      "dot-assethub#4": { kind: "ready" },
    } satisfies Record<string, RequestStatus>;

    expect(projectChainflipTopUps(records, statuses, 500)[0]).toMatchObject({
      progress: { view: { kind: "active", activeStageKey: "cash-top-up" } },
      state: {
        kind: "finishing",
        status: "Adding to your balance",
      },
    });
  });

  it("projects failed and settled requests as history records", () => {
    const records = [
      { tradeN: 5, amountHuman: "40", startedAt: 500 },
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
    ];
    const statuses = {
      "#5": { kind: "failed", reason: "Deposit expired" },
    } satisfies Record<string, RequestStatus>;
    const now = 900;

    // With no persisted failure time, the failure is dated at the observation time.
    expect(projectChainflipTopUps(records, statuses, now).map(({ state }) => state)).toEqual([
      { kind: "failed", at: now, reason: "Deposit expired" },
      { kind: "settled", at: 800, creditedAmount: "100.25" },
    ]);
    expect(projectChainflipTopUps(records, statuses, now)[1]?.details).toEqual({
      network: { label: "Bitcoin", icon: "/icons/bitcoin.svg" },
      token: { label: "BTC", icon: "/icons/bitcoin.svg" },
      provider: { label: "Chainflip", icon: "/icons/chainflip.png" },
      depositAddress: "bc1q-saved-deposit",
      arrivalEstimate: "≈10 min after your transfer",
    });
  });

  it("keeps a persisted failure time over the observation time", () => {
    const failedAt = 700;
    const records = [
      {
        tradeN: 8,
        amountHuman: "40",
        startedAt: 500,
        progress: createFundingProgressSnapshot(chainflipProgressProvider.createProfile(), {
          failedAt,
        }),
      },
    ];
    const statuses = {
      "#8": { kind: "failed", reason: "Deposit expired" },
    } satisfies Record<string, RequestStatus>;

    expect(projectChainflipTopUps(records, statuses, 900)[0]?.state).toEqual({
      kind: "failed",
      at: failedAt,
      reason: "Deposit expired",
    });
  });

  it("ignores incomplete records and rejects foreign identifiers", () => {
    expect(projectChainflipTopUps([{ amountHuman: "25", startedAt: 100 }], {})).toEqual([]);
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
      { tradeN: 7, amountHuman: "25", startedAt: 100, sourceId: "meld-card" },
      { tradeN: 7, amountHuman: "30", startedAt: 110, sourceId: "dot-assethub" },
    ];
    expect(projectChainflipTopUps(records, {}).map(({ id }) => id)).toEqual([
      "crypto:dot-assethub#7",
    ]);
  });

  it("keeps route details available for legacy records", () => {
    expect(
      projectChainflipTopUps([{ tradeN: 7, amountHuman: "25", startedAt: 100 }], {})[0]?.details,
    ).toEqual({
      provider: { label: "Chainflip", icon: "/icons/chainflip.png" },
      arrivalEstimate: "≈10 min after your transfer",
    });
  });
});
