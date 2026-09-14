import { fundingProgress } from "./model";
import type {
  FundingProgressProjection,
  FundingProgressProjectionInput,
  FundingProgressSnapshot,
  FundingProgressState,
} from "./types";

function snapshotState(snapshot: FundingProgressSnapshot): FundingProgressState {
  if (snapshot.settledAt !== undefined) return { kind: "settled" };
  const confirmedIndex = snapshot.profile.stages.findIndex(
    (stage) => stage.key === snapshot.confirmedStageKey,
  );
  const confirmedStageKey =
    snapshot.routeCompletedAt !== undefined && confirmedIndex < snapshot.profile.routeStageCount
      ? snapshot.profile.stages[snapshot.profile.routeStageCount - 1]?.key
      : snapshot.confirmedStageKey;
  const stageStartedAt = confirmedStageKey
    ? snapshot.stageTimestamps[confirmedStageKey]
    : undefined;
  if (snapshot.failedAt !== undefined) {
    return {
      kind: "failed",
      failedAt: snapshot.failedAt,
      confirmedStageKey,
      detectedAt: snapshot.detectedAt,
      stageStartedAt,
      routeCompletedAt: snapshot.routeCompletedAt,
    };
  }
  if (confirmedStageKey) {
    return {
      kind: "active",
      confirmedStageKey,
      detectedAt: snapshot.detectedAt,
      stageStartedAt,
      routeCompletedAt: snapshot.routeCompletedAt,
    };
  }
  return { kind: "waiting" };
}

function clockTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getHours()}:${date.getMinutes().toString().padStart(2, "0")}`;
}

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function calendarDate(timestamp: number): string {
  const date = new Date(timestamp);
  return `${weekdays[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]}`;
}

function waitingEstimate(snapshot: FundingProgressSnapshot): string {
  if (snapshot.preDetectionEstimateText) return snapshot.preDetectionEstimateText;
  const minutes = Math.max(1, Math.round(snapshot.profile.expectedUserDelayMs / 60_000));
  return `≈${minutes} min after your transfer`;
}

function estimatedCompletion(snapshot: FundingProgressSnapshot): number | undefined {
  if (snapshot.estimatedCompletionAt !== undefined) return snapshot.estimatedCompletionAt;
  if (snapshot.routeCompletedAt !== undefined) {
    return (
      snapshot.routeCompletedAt +
      snapshot.profile.stages
        .slice(snapshot.profile.routeStageCount)
        .reduce((total, stage) => total + stage.nominalMs, 0)
    );
  }
  const stageIndex = snapshot.profile.stages.findIndex(
    ({ key }) => key === snapshot.confirmedStageKey,
  );
  if (stageIndex < 0) return undefined;
  const startedAt =
    snapshot.stageTimestamps[snapshot.profile.stages[stageIndex]!.key] ?? snapshot.detectedAt;
  if (startedAt === undefined) return undefined;
  return (
    startedAt +
    snapshot.profile.stages.slice(stageIndex).reduce((total, stage) => total + stage.nominalMs, 0)
  );
}

export function fundingProgressEstimate(
  snapshot: FundingProgressSnapshot,
  now = Date.now(),
): string {
  if (snapshot.settledAt !== undefined) return "Done";
  if (snapshot.detectedAt === undefined && snapshot.routeCompletedAt === undefined) {
    return waitingEstimate(snapshot);
  }
  const readyAt = estimatedCompletion(snapshot);
  if (readyAt === undefined) return "";

  const ready = new Date(readyAt);
  const today = new Date(now);
  const sameDay =
    ready.getFullYear() === today.getFullYear() &&
    ready.getMonth() === today.getMonth() &&
    ready.getDate() === today.getDate();
  if (sameDay) return `Ready by ${clockTime(readyAt)}`;
  return `Ready by ${calendarDate(readyAt)}`;
}

export function projectFundingProgress(
  input: FundingProgressProjectionInput,
): FundingProgressProjection {
  const { snapshot, createdAt, now } = input;
  return Object.freeze({
    view: fundingProgress({
      profile: snapshot.profile,
      state: snapshotState(snapshot),
      createdAt,
      now,
    }),
    estimateText: fundingProgressEstimate(snapshot, now),
    cadenceMs: snapshot.profile.cadenceMs,
    ...(snapshot.detectedAt === undefined ? {} : { detectedAt: snapshot.detectedAt }),
    ...(snapshot.routeCompletedAt === undefined
      ? {}
      : { routeCompletedAt: snapshot.routeCompletedAt }),
    ...(snapshot.failedAt === undefined ? {} : { failedAt: snapshot.failedAt }),
    ...(snapshot.settledAt === undefined ? {} : { settledAt: snapshot.settledAt }),
    stageTimestamps: snapshot.stageTimestamps,
  });
}
