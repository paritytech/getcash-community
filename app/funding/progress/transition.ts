import { createFundingProgressSnapshot } from "./snapshot";
import type {
  FundingProgressEvent,
  FundingProgressSnapshot,
  FundingProgressSnapshotOptions,
} from "./types";

function remainingDuration(snapshot: FundingProgressSnapshot, fromIndex: number): number {
  return snapshot.profile.stages
    .slice(fromIndex)
    .reduce((total, stage) => total + stage.nominalMs, 0);
}

export function advanceFundingProgressSnapshot(
  snapshot: FundingProgressSnapshot,
  event: FundingProgressEvent,
): FundingProgressSnapshot {
  if (!Number.isFinite(event.at) || event.at < 0 || snapshot.settledAt !== undefined) {
    return snapshot;
  }

  const stages = snapshot.profile.stages;
  const firstSharedIndex = snapshot.profile.routeStageCount;
  const currentIndex = stages.findIndex((stage) => stage.key === snapshot.confirmedStageKey);
  let confirmedStageKey: string | undefined = snapshot.confirmedStageKey;
  let latestRouteStatus: string | undefined = snapshot.latestRouteStatus;
  let routeCompletedAt: number | undefined = snapshot.routeCompletedAt;
  let detectedAt: number | undefined = snapshot.detectedAt;
  let stageTimestamps = snapshot.stageTimestamps;
  let failedAt: number | undefined = snapshot.failedAt;
  let settledAt: number | undefined = snapshot.settledAt;
  let estimatedCompletionAt: number | undefined = snapshot.estimatedCompletionAt;
  let changed = false;

  const acceptRouteStatus = () => {
    if (event.routeStatus && latestRouteStatus !== event.routeStatus) {
      latestRouteStatus = event.routeStatus;
      changed = true;
    }
  };
  const resume = () => {
    if (failedAt !== undefined) {
      failedAt = undefined;
      changed = true;
    }
  };

  switch (event.observation.kind) {
    case "waiting":
      if (currentIndex < 0 && routeCompletedAt === undefined) {
        resume();
        acceptRouteStatus();
      }
      break;
    case "hold":
      resume();
      break;
    case "route-complete": {
      resume();
      acceptRouteStatus();
      if (detectedAt === undefined) {
        detectedAt = event.at;
        changed = true;
      }
      if (currentIndex < firstSharedIndex) {
        const finalRouteStageKey = stages[firstSharedIndex - 1]?.key;
        if (finalRouteStageKey && confirmedStageKey !== finalRouteStageKey) {
          confirmedStageKey = finalRouteStageKey;
          changed = true;
        }
      }
      if (routeCompletedAt === undefined) {
        routeCompletedAt = event.at;
        estimatedCompletionAt = event.at + remainingDuration(snapshot, firstSharedIndex);
        changed = true;
      }
      break;
    }
    case "stage": {
      const stageKey = event.observation.stageKey;
      const nextIndex = stages.findIndex((stage) => stage.key === stageKey);
      if (nextIndex < currentIndex || nextIndex < 0) break;
      if (routeCompletedAt !== undefined && nextIndex < firstSharedIndex) break;
      resume();
      acceptRouteStatus();
      if (detectedAt === undefined) {
        detectedAt = event.at;
        changed = true;
      }
      if (stageTimestamps[stageKey] === undefined) {
        stageTimestamps = { ...stageTimestamps, [stageKey]: event.at };
        estimatedCompletionAt = event.at + remainingDuration(snapshot, nextIndex);
        changed = true;
      }
      if (nextIndex >= firstSharedIndex && routeCompletedAt === undefined) {
        routeCompletedAt = event.at;
        changed = true;
      }
      if (confirmedStageKey !== stageKey) {
        confirmedStageKey = stageKey;
        changed = true;
      }
      break;
    }
    case "failed":
      if (failedAt === undefined) {
        failedAt = event.at;
        changed = true;
      }
      break;
    case "settled":
      confirmedStageKey = stages.at(-1)?.key;
      failedAt = undefined;
      settledAt = event.at;
      changed = true;
      break;
  }

  if (!changed) return snapshot;
  const options: FundingProgressSnapshotOptions = {
    confirmedStageKey,
    latestRouteStatus,
    routeCompletedAt,
    detectedAt,
    stageTimestamps,
    failedAt,
    settledAt,
    preDetectionEstimateText: snapshot.preDetectionEstimateText,
    estimatedCompletionAt,
  };
  return createFundingProgressSnapshot(snapshot.profile, options);
}
