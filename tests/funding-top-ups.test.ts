import { describe, expect, it } from "vitest";
import { fundingSelectorConfig } from "../app/funding/config";
import {
  chainflipProgressProvider,
  createFundingProgressSnapshot,
  projectFundingProgress,
} from "../app/funding/progress";
import {
  hasFundingPendingContent,
  projectFundingTopUps,
  type FundingTopUp,
} from "../app/funding/top-ups";

function progress(startedAt: number) {
  return projectFundingProgress({
    snapshot: createFundingProgressSnapshot(chainflipProgressProvider.createProfile()),
    createdAt: startedAt,
    now: startedAt,
  });
}

const topUps = [
  {
    id: "bank:1",
    amount: "25",
    route: "bank",
    startedAt: 100,
    progress: progress(100),
    state: { kind: "awaiting-transfer", status: "Waiting for your transfer" },
  },
  {
    id: "crypto:2",
    amount: "50",
    route: "crypto",
    startedAt: 400,
    progress: progress(400),
    state: { kind: "finishing", status: "Received, finishing up" },
  },
  {
    id: "card:3",
    amount: "20",
    route: "card",
    startedAt: 200,
    progress: progress(200),
    details: {
      network: { label: "Bitcoin", icon: "/icons/bitcoin.svg" },
      token: { label: "BTC", icon: "/icons/bitcoin.svg" },
      depositAddress: "bc1q-saved-deposit",
    },
    state: { kind: "settled", at: 700, creditedAmount: "20.25" },
  },
  {
    id: "crypto:4",
    amount: "40",
    route: "crypto",
    startedAt: 500,
    progress: progress(500),
    state: { kind: "failed", at: 800, reason: "Deposit expired" },
  },
] as const satisfies readonly FundingTopUp[];

describe("funding top-up projections", () => {
  it("separates active top-ups from settled and failed history", () => {
    const sections = projectFundingTopUps(topUps, fundingSelectorConfig);

    expect(sections.inProgress.map(({ id }) => id)).toEqual(["crypto:2", "bank:1"]);
    expect(sections.past.map(({ id }) => id)).toEqual(["crypto:4", "card:3"]);
    expect(sections.latestSettled?.id).toBe("card:3");
    expect(sections.latestSettled?.details?.depositAddress).toBe("bc1q-saved-deposit");
  });

  it("says a refunded crypto top-up was returned, not that it failed", () => {
    const refunded = { ...topUps[3]!, state: { ...topUps[3]!.state, refunded: true } };
    const sections = projectFundingTopUps([refunded], fundingSelectorConfig);
    expect(sections.past[0]?.state).toMatchObject({ kind: "failed", status: "Deposit returned" });
    expect(projectFundingTopUps([topUps[3]!], fundingSelectorConfig).past[0]?.state).toMatchObject({
      status: "Failed",
    });
  });

  it("uses route configuration for presentation", () => {
    const sections = projectFundingTopUps(topUps, fundingSelectorConfig);

    expect(sections.inProgress[0]).toMatchObject({
      routeLabel: "Crypto",
      routeIcon: "/icons/crypto.svg",
      estimate: "~3 min",
      state: {
        kind: "finishing",
        status: "Received, finishing up",
        detail: "Ready ~3 min",
      },
    });
    expect(sections.inProgress[1]?.state).toMatchObject({
      kind: "awaiting-transfer",
      detail: "Tap for the details",
    });
  });

  it("keeps Pending available for active and latest-settled combinations", () => {
    const both = projectFundingTopUps(topUps, fundingSelectorConfig);
    const activeOnly = projectFundingTopUps(topUps.slice(0, 2), fundingSelectorConfig);
    const settledOnly = projectFundingTopUps([topUps[2]!], fundingSelectorConfig);
    const failedOnly = projectFundingTopUps([topUps[3]!], fundingSelectorConfig);

    expect(hasFundingPendingContent(both.inProgress, both.latestSettled)).toBe(true);
    expect(hasFundingPendingContent(activeOnly.inProgress, activeOnly.latestSettled)).toBe(true);
    expect(hasFundingPendingContent(settledOnly.inProgress, settledOnly.latestSettled)).toBe(true);
    expect(hasFundingPendingContent(failedOnly.inProgress, failedOnly.latestSettled)).toBe(false);
  });

  it("keeps Pending in place when its final active top-up settles", () => {
    const active = projectFundingTopUps([topUps[0]!], fundingSelectorConfig);
    const settled = projectFundingTopUps(
      [{ ...topUps[0]!, state: { kind: "settled", at: 900 } }],
      fundingSelectorConfig,
    );

    expect(hasFundingPendingContent(active.inProgress, active.latestSettled)).toBe(true);
    expect(hasFundingPendingContent(settled.inProgress, settled.latestSettled)).toBe(true);
  });

  it("uses the requested amount when settlement has no credited amount", () => {
    const sections = projectFundingTopUps(
      [
        {
          id: "crypto:5",
          amount: "100",
          route: "crypto",
          startedAt: 800,
          progress: progress(800),
          state: { kind: "settled", at: 900 },
        },
      ],
      fundingSelectorConfig,
    );

    expect(sections.past[0]?.state).toEqual({
      kind: "settled",
      status: "Added",
      at: 900,
      creditedAmount: "100",
    });
  });

  it("falls back to the start time for failures without a terminal timestamp", () => {
    const sections = projectFundingTopUps(
      [
        {
          id: "crypto:6",
          amount: "15",
          route: "crypto",
          startedAt: 1_000,
          progress: progress(1_000),
          state: { kind: "failed", reason: "Unavailable" },
        },
      ],
      fundingSelectorConfig,
    );

    expect(sections.past[0]?.state).toEqual({
      kind: "failed",
      status: "Failed",
      at: 1_000,
      reason: "Unavailable",
    });
    expect(sections.latestSettled).toBeNull();
  });

  it("does not mutate provider ordering", () => {
    const providerOrder = [...topUps];
    projectFundingTopUps(providerOrder, fundingSelectorConfig);
    expect(providerOrder.map(({ id }) => id)).toEqual(topUps.map(({ id }) => id));
  });
});

describe("fiat routes in the shell list", () => {
  it("labels card and bank top-ups from the route config", () => {
    const base = {
      amount: "100",
      startedAt: 100,
      progress: projectFundingProgress({
        snapshot: createFundingProgressSnapshot(chainflipProgressProvider.createProfile()),
        createdAt: 100,
        now: 200,
      }),
      state: { kind: "awaiting-transfer" as const, status: "Waiting for your payment" },
    };
    const sections = projectFundingTopUps(
      [
        { ...base, id: "card:meld-card#1", route: "card" },
        { ...base, id: "bank:meld-bank#1", route: "bank" },
      ],
      fundingSelectorConfig,
    );
    expect(sections.inProgress.map(({ routeLabel }) => routeLabel).sort()).toEqual([
      "Bank",
      "Card",
    ]);
  });
});
