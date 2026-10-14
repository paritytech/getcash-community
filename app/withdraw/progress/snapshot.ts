import type {
  FundingProgressProfile,
  FundingProgressSnapshot,
  FundingProgressSnapshotOptions,
} from "./types";

function cloneProfile(profile: FundingProgressProfile): FundingProgressProfile {
  return Object.freeze({
    ...profile,
    stages: Object.freeze(profile.stages.map((stage) => Object.freeze({ ...stage }))),
  });
}

export function createFundingProgressSnapshot(
  profile: FundingProgressProfile,
  options: FundingProgressSnapshotOptions = {},
): FundingProgressSnapshot {
  return Object.freeze({
    profile: cloneProfile(profile),
    ...(options.confirmedStageKey ? { confirmedStageKey: options.confirmedStageKey } : {}),
    ...(options.routeCompletedAt !== undefined
      ? { routeCompletedAt: options.routeCompletedAt }
      : {}),
    ...(options.detectedAt !== undefined ? { detectedAt: options.detectedAt } : {}),
    stageTimestamps: Object.freeze({ ...options.stageTimestamps }),
    ...(options.failedAt !== undefined ? { failedAt: options.failedAt } : {}),
    ...(options.settledAt !== undefined ? { settledAt: options.settledAt } : {}),
    ...(options.preDetectionEstimateText
      ? { preDetectionEstimateText: options.preDetectionEstimateText }
      : {}),
    ...(options.estimatedCompletionAt !== undefined
      ? { estimatedCompletionAt: options.estimatedCompletionAt }
      : {}),
  });
}
