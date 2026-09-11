import { describe, expect, it } from "vitest";
import {
  CAP,
  DETECT,
  PRECAP,
  chainflipProgressProvider,
  composeFundingProgressProfile,
  createFundingProgressRegistry,
  fundingProgress,
  fundingProgressFloors,
  observeChainflipProgress,
  observeSharedCashProgress,
} from "../app/funding/progress";
import type {
  FundingProgressProfile,
  FundingProgressRouteDefinition,
  FundingProgressSharedDefinition,
} from "../app/funding/progress/types";

const SECOND = 1_000;

function profile(): FundingProgressProfile {
  return composeFundingProgressProfile(
    {
      id: "test",
      version: 1,
      expectedUserDelayMs: 100 * SECOND,
      cadenceMs: SECOND,
      stages: [
        { key: "route-a", nodeLabel: "A", activeLabel: "Doing A", nominalMs: 60 * SECOND },
        { key: "route-b", nodeLabel: "B", activeLabel: "Doing B", nominalMs: 30 * SECOND },
      ],
      observe: () => ({ kind: "hold" }),
    },
    {
      stages: [
        { key: "shared", nodeLabel: "Shared", activeLabel: "Shared work", nominalMs: 10 * SECOND },
      ],
    },
  );
}

describe("funding progress model", () => {
  it("approaches but never reaches the waiting cap", () => {
    const p = profile();
    const start = 10_000;
    expect(
      fundingProgress({ profile: p, state: { kind: "waiting" }, createdAt: start, now: start })
        .value,
    ).toBe(0);
    const late = fundingProgress({
      profile: p,
      state: { kind: "waiting" },
      createdAt: start,
      now: start + 10_000 * SECOND,
    });
    expect(late.value).toBeLessThanOrEqual(PRECAP);
    expect(late.activeNodeIndex).toBe(0);
    expect(late.label).toBe("Waiting for your transfer");
  });

  it("jumps to detection and stays inside the confirmed stage", () => {
    const p = profile();
    const detectedAt = 20_000;
    const start = fundingProgress({
      profile: p,
      state: { kind: "active", confirmedStageKey: "route-a", detectedAt },
      createdAt: 0,
      now: detectedAt,
    });
    const late = fundingProgress({
      profile: p,
      state: { kind: "active", confirmedStageKey: "route-a", detectedAt },
      createdAt: 0,
      now: detectedAt + 10_000 * SECOND,
    });
    const floors = fundingProgressFloors(p);

    expect(start.value).toBe(DETECT);
    expect(late.value).toBeGreaterThan(start.value);
    expect(late.value).toBeLessThan(floors[1]!);
    expect(late.activeStageKey).toBe("route-a");
  });

  it("keeps filling when a stage finishes ahead of its nominal schedule", () => {
    const p = profile();
    const floors = fundingProgressFloors(p);
    const detectedAt = 0;
    // route-a is nominally 60s but completes after 10s.
    const stageStartedAt = 10 * SECOND;
    const state = {
      kind: "active" as const,
      confirmedStageKey: "route-b",
      detectedAt,
      stageStartedAt,
    };

    const atStart = fundingProgress({ profile: p, state, createdAt: 0, now: stageStartedAt });
    const later = fundingProgress({
      profile: p,
      state,
      createdAt: 0,
      now: stageStartedAt + 15 * SECOND,
    });

    expect(atStart.value).toBe(floors[1]);
    expect(later.value).toBeGreaterThan(floors[1]!);
    expect(later.value).toBeLessThan(floors[2]!);
    expect(later.stageElapsedMs).toBe(15 * SECOND);
  });

  it("does not jump ahead when a stage finishes behind its nominal schedule", () => {
    const p = profile();
    const floors = fundingProgressFloors(p);
    // route-a is nominally 60s but takes 120s.
    const stageStartedAt = 120 * SECOND;
    const view = fundingProgress({
      profile: p,
      state: { kind: "active", confirmedStageKey: "route-b", detectedAt: 0, stageStartedAt },
      createdAt: 0,
      now: stageStartedAt,
    });
    expect(view.value).toBe(floors[1]);
  });

  it("uses duration-weighted floors for any stage count", () => {
    const floors = fundingProgressFloors(profile());
    expect(floors).toHaveLength(4);
    expect(floors[0]).toBe(DETECT);
    expect(floors[1]).toBeCloseTo(DETECT + (1 - DETECT) * 0.6);
    expect(floors[2]).toBeCloseTo(DETECT + (1 - DETECT) * 0.9);
    expect(floors[3]).toBe(1);
  });

  it("jumps to a skipped stage floor without inventing detection time", () => {
    const p = profile();
    const view = fundingProgress({
      profile: p,
      state: { kind: "active", confirmedStageKey: "shared" },
      createdAt: 0,
      now: 500_000,
    });
    expect(view.value).toBeCloseTo(fundingProgressFloors(p)[2]!);
    expect(view.nodes.map(({ state }) => state)).toEqual([
      "complete",
      "complete",
      "complete",
      "current",
    ]);
  });

  it("parks at the route boundary until shared work starts", () => {
    const p = profile();
    const routeCompletedAt = 100 * SECOND;
    const view = fundingProgress({
      profile: p,
      state: {
        kind: "active",
        confirmedStageKey: "route-b",
        detectedAt: routeCompletedAt,
        routeCompletedAt,
      },
      createdAt: 0,
      now: routeCompletedAt + 10 * SECOND,
    });

    expect(view).toMatchObject({
      activeNodeIndex: 2,
      activeStageKey: "route-b",
      label: "Payment received",
      stageElapsedMs: 10 * SECOND,
    });
    expect(view.value).toBe(fundingProgressFloors(p)[p.routeStageCount]);
    expect(view.nodes.map(({ state }) => state)).toEqual([
      "complete",
      "complete",
      "current",
      "upcoming",
    ]);
  });

  it("caps active work and settles immediately", () => {
    const p = profile();
    const active = fundingProgress({
      profile: p,
      state: { kind: "active", confirmedStageKey: "shared", detectedAt: 0 },
      createdAt: 0,
      now: 1_000_000,
    });
    const settled = fundingProgress({
      profile: p,
      state: { kind: "settled" },
      createdAt: 0,
      now: 1,
    });
    expect(active.value).toBeLessThanOrEqual(CAP);
    expect(settled.value).toBe(1);
    expect(settled.nodes.every(({ state }) => state === "complete")).toBe(true);
  });

  it("freezes a failure at its failure time", () => {
    const p = profile();
    const state = {
      kind: "failed" as const,
      failedAt: 40 * SECOND,
      detectedAt: 0,
      confirmedStageKey: "route-a",
    };
    const first = fundingProgress({ profile: p, state, createdAt: 0, now: 50 * SECOND });
    const later = fundingProgress({ profile: p, state, createdAt: 0, now: 500 * SECOND });
    expect(later.value).toBe(first.value);
    expect(later.kind).toBe("failed");
  });

  it("falls back safely when a stored stage key is unknown", () => {
    const p = profile();
    const view = fundingProgress({
      profile: p,
      state: { kind: "active", confirmedStageKey: "removed", detectedAt: 0 },
      createdAt: 0,
      now: 10 * SECOND,
    });
    expect(view.value).toBeLessThan(PRECAP);
    expect(view.activeNodeIndex).toBe(0);
  });
});

describe("funding progress registry", () => {
  it("composes Chainflip ingress with the shared CASH stages", () => {
    const p = chainflipProgressProvider.createProfile();
    expect(p.stages.map(({ key }) => key)).toEqual([
      "chainflip-receiving",
      "chainflip-swapping",
      "chainflip-sending",
      "cash-conversion",
      "cash-teleport",
      "cash-top-up",
    ]);
    expect(p.stages).toHaveLength(6);
    expect(p.routeStageCount).toBe(3);
    expect(p.startedNodeLabel).toBe("Payment seen");
    expect(p.stages[0]).toMatchObject({
      nodeLabel: "Confirmed",
      activeLabel: "Confirming your payment",
    });
    expect(p.routeCompletedLabel).toBe("Payment received");
  });

  it("scales only the ingress portion from a route estimate", () => {
    const duration = 12 * 60 * SECOND;
    const p = chainflipProgressProvider.createProfile({ ingressDurationMs: duration });
    const ingress = p.stages.slice(0, 3).reduce((sum, stage) => sum + stage.nominalMs, 0);
    expect(ingress).toBeCloseTo(duration);
    expect(p.stages[3]?.nominalMs).toBe(3 * 60 * SECOND);
  });

  it("maps normalized route and shared statuses", () => {
    expect(observeChainflipProgress("receiving")).toEqual({
      kind: "stage",
      stageKey: "chainflip-receiving",
    });
    expect(observeChainflipProgress("complete")).toEqual({ kind: "route-complete" });
    expect(observeSharedCashProgress("await-native")).toEqual({ kind: "hold" });
    expect(observeSharedCashProgress("swap")).toEqual({
      kind: "stage",
      stageKey: "cash-conversion",
    });
    expect(observeSharedCashProgress("await-arrival")).toEqual({
      kind: "stage",
      stageKey: "cash-teleport",
    });
    expect(observeSharedCashProgress("working")).toEqual({
      kind: "stage",
      stageKey: "cash-top-up",
    });
  });

  it("rejects invalid profiles and duplicate providers", () => {
    const route = {
      id: "duplicate",
      version: 1,
      expectedUserDelayMs: SECOND,
      cadenceMs: SECOND,
      stages: [{ key: "same", nodeLabel: "A", activeLabel: "A", nominalMs: SECOND }],
      observe: () => ({ kind: "hold" as const }),
    } satisfies FundingProgressRouteDefinition;
    const shared = {
      stages: [{ key: "same", nodeLabel: "B", activeLabel: "B", nominalMs: SECOND }],
    } satisfies FundingProgressSharedDefinition;

    expect(() => composeFundingProgressProfile(route, shared)).toThrow(/unique/);
    expect(() =>
      createFundingProgressRegistry([chainflipProgressProvider, chainflipProgressProvider]),
    ).toThrow(/duplicate/);
  });
});
