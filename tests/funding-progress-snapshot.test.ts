import { describe, expect, it } from "vitest";
import {
  chainflipProgressProvider,
  createFundingProgressSnapshot,
  createLegacyFundingProgressSnapshot,
  parseFundingProgressSnapshot,
  resolveFundingProgressSnapshot,
} from "../app/funding/progress";
import type { FundingProgressProfile } from "../app/funding/progress";

function profile(): FundingProgressProfile {
  return chainflipProgressProvider.createProfile({ ingressDurationMs: 12 * 60_000 });
}

describe("funding progress snapshots", () => {
  it("round-trips the full profile and timing context", () => {
    const original = createFundingProgressSnapshot(profile(), {
      confirmedStageKey: "chainflip-swapping",
      latestRouteStatus: "swapping",
      routeCompletedAt: 2_000,
      detectedAt: 1_000,
      stageTimestamps: {
        "chainflip-receiving": 1_000,
        "chainflip-swapping": 1_500,
      },
      preDetectionEstimateText: "≈12 min after your transfer",
      estimatedCompletionAt: 20_000,
    });

    const restored = parseFundingProgressSnapshot(JSON.parse(JSON.stringify(original)));
    expect(restored).toEqual(original);
    expect(restored?.profile.stages).toHaveLength(6);
  });

  it("restores the route boundary metadata on existing Chainflip snapshots", () => {
    const persisted = JSON.parse(JSON.stringify(createFundingProgressSnapshot(profile()))) as {
      profile: Record<string, unknown>;
    };
    delete persisted.profile.routeStageCount;
    delete persisted.profile.routeCompletedLabel;

    expect(parseFundingProgressSnapshot(persisted)?.profile).toMatchObject({
      routeStageCount: 3,
      routeCompletedLabel: "Payment received",
    });
  });

  it("keeps an existing snapshot stable when later profiles change", () => {
    const mutableProfile = JSON.parse(JSON.stringify(profile())) as FundingProgressProfile;
    const snapshot = createFundingProgressSnapshot(mutableProfile);
    (mutableProfile.stages[0] as { nodeLabel: string; nominalMs: number }).nodeLabel = "Changed";
    (mutableProfile.stages[0] as { nodeLabel: string; nominalMs: number }).nominalMs = 1;

    expect(snapshot.profile.stages[0]).toMatchObject({
      nodeLabel: "Confirmed",
      nominalMs: 10 * 60_000,
    });
  });

  it("upgrades display copy from an older route profile without losing progress", () => {
    const current = profile();
    const legacy = {
      ...current,
      version: 1,
      startedNodeLabel: "Started",
      stages: current.stages.map((stage) =>
        stage.key === "chainflip-receiving"
          ? { ...stage, nodeLabel: "Received", activeLabel: "Receiving your payment" }
          : stage,
      ),
    };
    const snapshot = createFundingProgressSnapshot(legacy, {
      confirmedStageKey: "chainflip-receiving",
      latestRouteStatus: "receiving",
      detectedAt: 1_000,
      stageTimestamps: { "chainflip-receiving": 1_000 },
    });

    const upgraded = resolveFundingProgressSnapshot(snapshot, current);

    expect(upgraded).toMatchObject({
      confirmedStageKey: "chainflip-receiving",
      detectedAt: 1_000,
      stageTimestamps: { "chainflip-receiving": 1_000 },
      profile: {
        version: 2,
        startedNodeLabel: "Payment seen",
      },
    });
    expect(upgraded.profile.stages[0]).toMatchObject({
      nodeLabel: "Confirmed",
      activeLabel: "Confirming your payment",
    });
  });

  it("seeds only facts known from legacy waiting, funded, and settled records", () => {
    const p = profile();
    const waiting = createLegacyFundingProgressSnapshot(p);
    const funded = createLegacyFundingProgressSnapshot(p, { fundedAt: 10_000 });
    const settled = createLegacyFundingProgressSnapshot(p, { settledAt: 20_000 });

    expect(waiting).toMatchObject({ stageTimestamps: {} });
    expect(waiting.confirmedStageKey).toBeUndefined();
    expect(waiting.detectedAt).toBeUndefined();
    expect(funded).toMatchObject({
      confirmedStageKey: "cash-conversion",
      routeCompletedAt: 10_000,
      detectedAt: 10_000,
      stageTimestamps: { "cash-conversion": 10_000 },
    });
    expect(settled).toMatchObject({
      confirmedStageKey: "cash-top-up",
      settledAt: 20_000,
      stageTimestamps: {},
    });
  });

  it("applies stronger durable facts to an otherwise valid snapshot", () => {
    const p = profile();
    const snapshot = createFundingProgressSnapshot(p);

    expect(resolveFundingProgressSnapshot(snapshot, p, { fundedAt: 10_000 })).toMatchObject({
      confirmedStageKey: "cash-conversion",
      detectedAt: 10_000,
      stageTimestamps: { "cash-conversion": 10_000 },
    });
    expect(resolveFundingProgressSnapshot(snapshot, p, { settledAt: 20_000 })).toMatchObject({
      confirmedStageKey: "cash-top-up",
      settledAt: 20_000,
      stageTimestamps: {},
    });
  });

  it("does not backfill skipped stages when a later stage was already observed", () => {
    const p = profile();
    const snapshot = createFundingProgressSnapshot(p, {
      confirmedStageKey: "cash-teleport",
      detectedAt: 8_000,
      stageTimestamps: { "cash-teleport": 9_000 },
    });
    const restored = resolveFundingProgressSnapshot(snapshot, p, { fundedAt: 10_000 });

    expect(restored).toMatchObject({
      confirmedStageKey: "cash-teleport",
      routeCompletedAt: 10_000,
      stageTimestamps: { "cash-teleport": 9_000 },
    });
    expect(restored.stageTimestamps["cash-conversion"]).toBeUndefined();
  });

  it("falls back safely for partial or corrupt snapshots", () => {
    const p = profile();
    const partial = { schemaVersion: 1, profile: p };
    const corrupt = {
      ...createFundingProgressSnapshot(p),
      confirmedStageKey: "unknown-stage",
    };

    expect(resolveFundingProgressSnapshot(partial, p, { fundedAt: 3_000 })).toMatchObject({
      confirmedStageKey: "cash-conversion",
      detectedAt: 3_000,
    });
    expect(resolveFundingProgressSnapshot(corrupt, p, { settledAt: 4_000 })).toMatchObject({
      confirmedStageKey: "cash-top-up",
      settledAt: 4_000,
    });
  });
});
