import { describe, expect, it } from "vitest";
import type { PaymentState } from "@getsome/core";
import {
  advanceFundingProgressSnapshot,
  chainflipProgressProvider,
  createFundingProgressSnapshot,
  fundingProgressSignalForPaymentState,
  fundingProgressSignalForSharedStep,
} from "../app/funding/progress";

function snapshot() {
  return createFundingProgressSnapshot(
    chainflipProgressProvider.createProfile({ ingressDurationMs: 12 * 60_000 }),
  );
}

function routeEvent(status: string, at: number) {
  return {
    observation: chainflipProgressProvider.observeRoute(status),
    routeStatus: status,
    at,
  };
}

describe("funding progress transitions", () => {
  it("records route detection and ignores duplicate or stale statuses", () => {
    const waiting = advanceFundingProgressSnapshot(snapshot(), routeEvent("waiting", 100));
    const receiving = advanceFundingProgressSnapshot(waiting, routeEvent("receiving", 200));
    const duplicate = advanceFundingProgressSnapshot(receiving, routeEvent("receiving", 300));
    const sending = advanceFundingProgressSnapshot(receiving, routeEvent("sending", 400));
    const stale = advanceFundingProgressSnapshot(sending, routeEvent("swapping", 500));
    const complete = advanceFundingProgressSnapshot(sending, routeEvent("complete", 600));

    expect(waiting).toMatchObject({ latestRouteStatus: "waiting", stageTimestamps: {} });
    expect(waiting.detectedAt).toBeUndefined();
    expect(receiving).toMatchObject({
      confirmedStageKey: "chainflip-receiving",
      latestRouteStatus: "receiving",
      detectedAt: 200,
      stageTimestamps: { "chainflip-receiving": 200 },
    });
    expect(receiving.estimatedCompletionAt).toBe(
      200 + receiving.profile.stages.reduce((total, stage) => total + stage.nominalMs, 0),
    );
    expect(duplicate).toBe(receiving);
    expect(sending.stageTimestamps).toEqual({
      "chainflip-receiving": 200,
      "chainflip-sending": 400,
    });
    expect(stale).toBe(sending);
    expect(complete).toMatchObject({
      confirmedStageKey: "chainflip-sending",
      latestRouteStatus: "complete",
      routeCompletedAt: 600,
    });
  });

  it("moves a directly completed route to its boundary without inventing stage timestamps", () => {
    const complete = advanceFundingProgressSnapshot(snapshot(), routeEvent("complete", 600));
    const stale = advanceFundingProgressSnapshot(complete, routeEvent("receiving", 700));
    const conversion = advanceFundingProgressSnapshot(complete, {
      ...fundingProgressSignalForSharedStep("swap"),
      at: 800,
    });

    expect(complete).toMatchObject({
      confirmedStageKey: "chainflip-sending",
      latestRouteStatus: "complete",
      detectedAt: 600,
      routeCompletedAt: 600,
      stageTimestamps: {},
    });
    expect(complete.estimatedCompletionAt).toBe(600 + 9 * 60_000);
    expect(stale).toBe(complete);
    expect(conversion).toMatchObject({
      confirmedStageKey: "cash-conversion",
      routeCompletedAt: 600,
      stageTimestamps: { "cash-conversion": 800 },
    });
  });

  it("advances through shared CASH processing without inventing skipped timestamps", () => {
    const ingress = advanceFundingProgressSnapshot(snapshot(), routeEvent("sending", 100));
    const waiting = advanceFundingProgressSnapshot(ingress, {
      ...fundingProgressSignalForSharedStep("await-native"),
      at: 200,
    });
    const conversion = advanceFundingProgressSnapshot(waiting, {
      ...fundingProgressSignalForSharedStep("swap"),
      at: 300,
    });
    const teleport = advanceFundingProgressSnapshot(conversion, {
      ...fundingProgressSignalForSharedStep("await-arrival"),
      at: 400,
    });
    const sameTeleport = advanceFundingProgressSnapshot(teleport, {
      ...fundingProgressSignalForSharedStep("await-arrival"),
      at: 500,
    });
    const topUp = advanceFundingProgressSnapshot(teleport, {
      ...fundingProgressSignalForSharedStep("done"),
      at: 600,
    });

    expect(waiting).toBe(ingress);
    expect(conversion).toMatchObject({
      confirmedStageKey: "cash-conversion",
      routeCompletedAt: 300,
    });
    expect(teleport).toMatchObject({
      confirmedStageKey: "cash-teleport",
      stageTimestamps: {
        "chainflip-sending": 100,
        "cash-conversion": 300,
        "cash-teleport": 400,
      },
    });
    expect(sameTeleport).toBe(teleport);
    expect(topUp.confirmedStageKey).toBe("cash-top-up");
  });

  it("freezes failures, resumes on observed activity, and makes settlement terminal", () => {
    const receiving = advanceFundingProgressSnapshot(snapshot(), routeEvent("receiving", 100));
    const failed = advanceFundingProgressSnapshot(receiving, {
      observation: { kind: "failed" },
      at: 200,
    });
    const duplicateFailure = advanceFundingProgressSnapshot(failed, {
      observation: { kind: "failed" },
      at: 300,
    });
    const resumed = advanceFundingProgressSnapshot(failed, routeEvent("receiving", 400));
    const settled = advanceFundingProgressSnapshot(resumed, {
      observation: { kind: "settled" },
      at: 500,
    });

    expect(failed.failedAt).toBe(200);
    expect(duplicateFailure).toBe(failed);
    expect(resumed.failedAt).toBeUndefined();
    expect(settled).toMatchObject({ confirmedStageKey: "cash-top-up", settledAt: 500 });
    expect(advanceFundingProgressSnapshot(settled, routeEvent("swapping", 600))).toBe(settled);
  });
});

describe("funding progress signals", () => {
  it("normalizes Chainflip, shared, failure, and settlement states", () => {
    const awaiting = { phase: "awaiting-deposit" } as PaymentState;
    const swapping = { phase: "swapping", swap: "sending" } as PaymentState;
    const working = { phase: "working" } as PaymentState;
    const failed = { phase: "failed" } as PaymentState;
    const done = { phase: "done" } as PaymentState;

    expect(fundingProgressSignalForPaymentState(chainflipProgressProvider, awaiting)).toEqual({
      observation: { kind: "waiting" },
      routeStatus: "waiting",
    });
    expect(fundingProgressSignalForPaymentState(chainflipProgressProvider, swapping)).toEqual({
      observation: { kind: "stage", stageKey: "chainflip-sending" },
      routeStatus: "sending",
    });
    expect(fundingProgressSignalForPaymentState(chainflipProgressProvider, working)).toEqual({
      observation: { kind: "stage", stageKey: "cash-top-up" },
    });
    expect(fundingProgressSignalForPaymentState(chainflipProgressProvider, failed)).toEqual({
      observation: { kind: "failed" },
    });
    expect(fundingProgressSignalForPaymentState(chainflipProgressProvider, done)).toEqual({
      observation: { kind: "settled" },
    });
  });
});
