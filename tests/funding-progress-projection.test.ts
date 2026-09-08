import { describe, expect, it } from "vitest";
import {
  advanceFundingProgressSnapshot,
  chainflipProgressProvider,
  createFundingProgressSnapshot,
  fundingProgressFloors,
  fundingProgressEstimate,
  projectFundingProgress,
} from "../app/funding/progress";

const at = (day: number, hour: number, minute: number) =>
  new Date(2026, 8, day, hour, minute).getTime();

describe("funding progress projections", () => {
  it("projects waiting progress with a relative estimate and route cadence", () => {
    const profile = chainflipProgressProvider.createProfile();
    const snapshot = createFundingProgressSnapshot(profile, {
      preDetectionEstimateText: "≈12 min after your transfer",
    });
    const projection = projectFundingProgress({
      snapshot,
      createdAt: at(1, 9, 0),
      now: at(1, 9, 5),
    });

    expect(projection).toMatchObject({
      estimateText: "≈12 min after your transfer",
      cadenceMs: 5_000,
      view: {
        kind: "waiting",
        label: "Waiting for your transfer",
        activeNodeIndex: 0,
      },
    });
    expect(projection.view.value).toBeGreaterThan(0);
    expect(projection.view.value).toBeLessThan(0.08);
  });

  it("derives active labels, elapsed time, and same-day estimates from the snapshot", () => {
    const profile = chainflipProgressProvider.createProfile();
    const snapshot = createFundingProgressSnapshot(profile, {
      confirmedStageKey: "chainflip-swapping",
      detectedAt: at(1, 9, 30),
      stageTimestamps: {
        "chainflip-receiving": at(1, 9, 30),
        "chainflip-swapping": at(1, 9, 45),
      },
      estimatedCompletionAt: at(1, 10, 5),
    });
    const projection = projectFundingProgress({
      snapshot,
      createdAt: at(1, 9, 0),
      now: at(1, 9, 47),
    });

    expect(projection).toMatchObject({
      estimateText: "Ready by 10:05",
      detectedAt: at(1, 9, 30),
      view: {
        kind: "active",
        activeStageKey: "chainflip-swapping",
        activeNodeIndex: 2,
        label: "Processing through Chainflip",
        stageElapsedMs: 2 * 60_000,
      },
    });
    expect(projection.stageTimestamps).toBe(snapshot.stageTimestamps);
  });

  it("renders direct route completion at the route boundary", () => {
    const profile = chainflipProgressProvider.createProfile();
    const completedAt = at(1, 9, 30);
    const snapshot = advanceFundingProgressSnapshot(createFundingProgressSnapshot(profile), {
      observation: { kind: "route-complete" },
      routeStatus: "complete",
      at: completedAt,
    });
    const projection = projectFundingProgress({
      snapshot,
      createdAt: at(1, 9, 0),
      now: at(1, 9, 35),
    });

    expect(projection.view).toMatchObject({
      kind: "active",
      activeStageKey: "chainflip-sending",
      activeNodeIndex: 3,
      label: "Payment received",
      stageElapsedMs: 5 * 60_000,
    });
    expect(projection.view.value).toBe(fundingProgressFloors(profile)[profile.routeStageCount]);
    expect(projection.estimateText).toBe("Ready by 9:39");
  });

  it("projects existing route-complete snapshots at the boundary", () => {
    const profile = chainflipProgressProvider.createProfile();
    const completedAt = at(1, 9, 30);
    const projection = projectFundingProgress({
      snapshot: createFundingProgressSnapshot(profile, { routeCompletedAt: completedAt }),
      createdAt: at(1, 9, 0),
      now: at(1, 9, 35),
    });

    expect(projection.view).toMatchObject({
      kind: "active",
      activeStageKey: "chainflip-sending",
      label: "Payment received",
    });
    expect(projection.view.value).toBe(fundingProgressFloors(profile)[profile.routeStageCount]);
  });

  it("derives a missing legacy estimate from the current stage timestamp", () => {
    const profile = chainflipProgressProvider.createProfile();
    const snapshot = createFundingProgressSnapshot(profile, {
      confirmedStageKey: "cash-conversion",
      detectedAt: at(1, 10, 0),
      stageTimestamps: { "cash-conversion": at(1, 10, 0) },
    });

    expect(fundingProgressEstimate(snapshot, at(1, 10, 1))).toBe("Ready by 10:09");
  });

  it("freezes failed progress and completes every node at settlement", () => {
    const profile = chainflipProgressProvider.createProfile();
    const failedAt = at(1, 10, 0);
    const failedSnapshot = createFundingProgressSnapshot(profile, {
      confirmedStageKey: "cash-teleport",
      detectedAt: at(1, 9, 30),
      stageTimestamps: { "cash-teleport": at(1, 9, 55) },
      failedAt,
    });
    const first = projectFundingProgress({
      snapshot: failedSnapshot,
      createdAt: at(1, 9, 0),
      now: at(1, 10, 1),
    });
    const later = projectFundingProgress({
      snapshot: failedSnapshot,
      createdAt: at(1, 9, 0),
      now: at(1, 11, 0),
    });

    expect(later.view).toEqual(first.view);
    expect(later.failedAt).toBe(failedAt);

    const settled = projectFundingProgress({
      snapshot: createFundingProgressSnapshot(profile, { settledAt: at(2, 9, 0) }),
      createdAt: at(1, 9, 0),
      now: at(2, 10, 0),
    });
    expect(settled).toMatchObject({
      estimateText: "Done",
      settledAt: at(2, 9, 0),
      view: { kind: "settled", value: 1, valueNow: 100, label: "Ready to spend" },
    });
    expect(settled.view.nodes.every(({ state }) => state === "complete")).toBe(true);
  });

  it("uses a concise calendar estimate when completion is on another day", () => {
    const profile = chainflipProgressProvider.createProfile();
    const snapshot = createFundingProgressSnapshot(profile, {
      confirmedStageKey: "chainflip-receiving",
      detectedAt: at(1, 23, 50),
      stageTimestamps: { "chainflip-receiving": at(1, 23, 50) },
      estimatedCompletionAt: at(2, 0, 15),
    });

    expect(fundingProgressEstimate(snapshot, at(1, 23, 55))).toBe("Ready by Wed 2 Sep");
  });
});
