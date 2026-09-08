import type {
  FundingProgressProfile,
  FundingProgressSnapshot,
  FundingProgressSnapshotOptions,
  FundingProgressStage,
  LegacyFundingProgressFacts,
} from "./types";

export const FUNDING_PROGRESS_SNAPSHOT_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isTimestamp(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function cloneProfile(profile: FundingProgressProfile): FundingProgressProfile {
  return Object.freeze({
    ...profile,
    stages: Object.freeze(profile.stages.map((stage) => Object.freeze({ ...stage }))),
  });
}

function parseProfile(value: unknown): FundingProgressProfile | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) return null;
  if (!Number.isInteger(value.version) || (value.version as number) < 1) return null;
  if (!isFiniteNumber(value.expectedUserDelayMs) || value.expectedUserDelayMs < 0) return null;
  if (!isFiniteNumber(value.cadenceMs) || value.cadenceMs <= 0) return null;
  if (typeof value.startedNodeLabel !== "string" || !value.startedNodeLabel) return null;
  if (typeof value.waitingLabel !== "string" || !value.waitingLabel) return null;
  if (typeof value.settledLabel !== "string" || !value.settledLabel) return null;
  if (!Array.isArray(value.stages) || value.stages.length === 0) return null;

  const keys = new Set<string>();
  const stages: FundingProgressStage[] = [];
  for (const stage of value.stages) {
    if (!isRecord(stage) || typeof stage.key !== "string" || !stage.key || keys.has(stage.key)) {
      return null;
    }
    if (typeof stage.nodeLabel !== "string" || !stage.nodeLabel) return null;
    if (typeof stage.activeLabel !== "string" || !stage.activeLabel) return null;
    if (!isFiniteNumber(stage.nominalMs) || stage.nominalMs <= 0) return null;
    keys.add(stage.key);
    stages.push({
      key: stage.key,
      nodeLabel: stage.nodeLabel,
      activeLabel: stage.activeLabel,
      nominalMs: stage.nominalMs,
    });
  }

  const routeStageCount =
    value.routeStageCount === undefined
      ? stages.findIndex((stage) => stage.key === "cash-conversion")
      : value.routeStageCount;
  if (
    !Number.isInteger(routeStageCount) ||
    (routeStageCount as number) <= 0 ||
    (routeStageCount as number) >= stages.length
  ) {
    return null;
  }
  const routeCompletedLabel = value.routeCompletedLabel ?? "Payment received";
  if (typeof routeCompletedLabel !== "string" || !routeCompletedLabel) return null;

  return cloneProfile({
    id: value.id,
    version: value.version as number,
    expectedUserDelayMs: value.expectedUserDelayMs,
    cadenceMs: value.cadenceMs,
    routeStageCount: routeStageCount as number,
    startedNodeLabel: value.startedNodeLabel,
    waitingLabel: value.waitingLabel,
    routeCompletedLabel,
    settledLabel: value.settledLabel,
    stages,
  });
}

function readOptionalTimestamp(
  value: Record<string, unknown>,
  key: string,
): number | undefined | null {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  return isTimestamp(candidate) ? candidate : null;
}

function readOptionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined | null {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  return typeof candidate === "string" && candidate ? candidate : null;
}

export function createFundingProgressSnapshot(
  profile: FundingProgressProfile,
  options: FundingProgressSnapshotOptions = {},
): FundingProgressSnapshot {
  return Object.freeze({
    schemaVersion: FUNDING_PROGRESS_SNAPSHOT_VERSION,
    profile: cloneProfile(profile),
    ...(options.confirmedStageKey ? { confirmedStageKey: options.confirmedStageKey } : {}),
    ...(options.latestRouteStatus ? { latestRouteStatus: options.latestRouteStatus } : {}),
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

export function parseFundingProgressSnapshot(value: unknown): FundingProgressSnapshot | null {
  if (!isRecord(value) || value.schemaVersion !== FUNDING_PROGRESS_SNAPSHOT_VERSION) return null;
  const profile = parseProfile(value.profile);
  if (!profile || !isRecord(value.stageTimestamps)) return null;

  const stageKeys = new Set(profile.stages.map((stage) => stage.key));
  const stageTimestamps: Record<string, number> = {};
  for (const [key, timestamp] of Object.entries(value.stageTimestamps)) {
    if (!stageKeys.has(key) || !isTimestamp(timestamp)) return null;
    stageTimestamps[key] = timestamp;
  }

  const confirmedStageKey = readOptionalString(value, "confirmedStageKey");
  const latestRouteStatus = readOptionalString(value, "latestRouteStatus");
  const preDetectionEstimateText = readOptionalString(value, "preDetectionEstimateText");
  const routeCompletedAt = readOptionalTimestamp(value, "routeCompletedAt");
  const detectedAt = readOptionalTimestamp(value, "detectedAt");
  const failedAt = readOptionalTimestamp(value, "failedAt");
  const settledAt = readOptionalTimestamp(value, "settledAt");
  const estimatedCompletionAt = readOptionalTimestamp(value, "estimatedCompletionAt");
  if (
    confirmedStageKey === null ||
    latestRouteStatus === null ||
    preDetectionEstimateText === null ||
    routeCompletedAt === null ||
    detectedAt === null ||
    failedAt === null ||
    settledAt === null ||
    estimatedCompletionAt === null
  ) {
    return null;
  }
  if (confirmedStageKey && !stageKeys.has(confirmedStageKey)) return null;

  return createFundingProgressSnapshot(profile, {
    confirmedStageKey,
    latestRouteStatus,
    routeCompletedAt,
    detectedAt,
    stageTimestamps,
    failedAt,
    settledAt,
    preDetectionEstimateText,
    estimatedCompletionAt,
  });
}

export function createLegacyFundingProgressSnapshot(
  profile: FundingProgressProfile,
  facts: LegacyFundingProgressFacts = {},
): FundingProgressSnapshot {
  return applyLegacyFacts(createFundingProgressSnapshot(profile), facts);
}

function applyLegacyFacts(
  snapshot: FundingProgressSnapshot,
  facts: LegacyFundingProgressFacts,
): FundingProgressSnapshot {
  const profile = snapshot.profile;
  const firstSharedStage = profile.stages[profile.routeStageCount];
  const finalStage = profile.stages.at(-1);
  const fundedAt = isTimestamp(facts.fundedAt) ? facts.fundedAt : undefined;
  const settledAt = isTimestamp(facts.settledAt) ? facts.settledAt : undefined;
  if (fundedAt === undefined && settledAt === undefined) return snapshot;
  const stageTimestamps = { ...snapshot.stageTimestamps };
  let confirmedStageKey = snapshot.confirmedStageKey;
  let routeCompletedAt = snapshot.routeCompletedAt;
  let detectedAt = snapshot.detectedAt;
  let changed = false;

  if (fundedAt !== undefined && firstSharedStage) {
    if (detectedAt === undefined) {
      detectedAt = fundedAt;
      changed = true;
    }
    const confirmedIndex = profile.stages.findIndex((stage) => stage.key === confirmedStageKey);
    const sharedIndex = profile.stages.indexOf(firstSharedStage);
    if (confirmedIndex <= sharedIndex && stageTimestamps[firstSharedStage.key] === undefined) {
      stageTimestamps[firstSharedStage.key] = fundedAt;
      changed = true;
    }
    if (confirmedIndex < sharedIndex) {
      confirmedStageKey = firstSharedStage.key;
      changed = true;
    }
    if (routeCompletedAt === undefined) {
      routeCompletedAt = fundedAt;
      changed = true;
    }
  }
  if (settledAt !== undefined && confirmedStageKey !== finalStage?.key) {
    confirmedStageKey = finalStage?.key;
    changed = true;
  }
  if (settledAt !== undefined && snapshot.settledAt === undefined) {
    changed = true;
  }
  if (!changed) return snapshot;

  return createFundingProgressSnapshot(profile, {
    confirmedStageKey,
    latestRouteStatus: snapshot.latestRouteStatus,
    routeCompletedAt,
    detectedAt,
    stageTimestamps,
    failedAt: snapshot.failedAt,
    settledAt: snapshot.settledAt ?? settledAt,
    preDetectionEstimateText: snapshot.preDetectionEstimateText,
    estimatedCompletionAt: snapshot.estimatedCompletionAt,
  });
}

function upgradeProfile(
  snapshot: FundingProgressSnapshot,
  profile: FundingProgressProfile,
): FundingProgressSnapshot {
  if (snapshot.profile.id !== profile.id || snapshot.profile.version >= profile.version) {
    return snapshot;
  }
  const stageKeys = new Set(profile.stages.map((stage) => stage.key));
  const confirmedStageKey =
    snapshot.confirmedStageKey && stageKeys.has(snapshot.confirmedStageKey)
      ? snapshot.confirmedStageKey
      : undefined;
  const stageTimestamps = Object.fromEntries(
    Object.entries(snapshot.stageTimestamps).filter(([key]) => stageKeys.has(key)),
  );
  return createFundingProgressSnapshot(profile, {
    confirmedStageKey,
    latestRouteStatus: snapshot.latestRouteStatus,
    routeCompletedAt: snapshot.routeCompletedAt,
    detectedAt: snapshot.detectedAt,
    stageTimestamps,
    failedAt: snapshot.failedAt,
    settledAt: snapshot.settledAt,
    preDetectionEstimateText: snapshot.preDetectionEstimateText,
    estimatedCompletionAt: snapshot.estimatedCompletionAt,
  });
}

export function resolveFundingProgressSnapshot(
  value: unknown,
  fallbackProfile: FundingProgressProfile,
  facts: LegacyFundingProgressFacts = {},
): FundingProgressSnapshot {
  const snapshot = parseFundingProgressSnapshot(value);
  return snapshot
    ? applyLegacyFacts(upgradeProfile(snapshot, fallbackProfile), facts)
    : createLegacyFundingProgressSnapshot(fallbackProfile, facts);
}
