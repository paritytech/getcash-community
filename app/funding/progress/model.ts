import type {
  FundingProgressInput,
  FundingProgressNodeView,
  FundingProgressProfile,
  FundingProgressView,
} from "./types";

export const PRECAP = 0.08;
export const DETECT = 0.15;
export const CAP = 0.95;

const FILL_RATE = 3;
const SEGMENT_LIMIT = 0.985;

export function fundingProgressFloors(profile: FundingProgressProfile): readonly number[] {
  const total = profile.stages.reduce((sum, stage) => sum + stage.nominalMs, 0);
  const floors = [DETECT];
  let elapsed = 0;

  for (const stage of profile.stages) {
    elapsed += stage.nominalMs;
    floors.push(DETECT + (1 - DETECT) * (elapsed / total));
  }

  return floors;
}

function waitingValue(profile: FundingProgressProfile, createdAt: number, now: number): number {
  const elapsed = Math.max(0, now - createdAt);
  return PRECAP * (1 - Math.exp((-FILL_RATE * elapsed) / profile.expectedUserDelayMs));
}

/**
 * Time spent inside the confirmed stage: measured from the recorded stage start, else from the
 * nominal schedule since detection, else zero.
 */
function stageElapsedMs(input: FundingProgressInput, stageIndex: number, now: number): number {
  const { profile, state } = input;
  if (state.kind !== "active" && state.kind !== "failed") return 0;
  if (state.stageStartedAt !== undefined) return Math.max(0, now - state.stageStartedAt);
  if (state.detectedAt === undefined) return 0;
  const scheduledStart = profile.stages
    .slice(0, stageIndex)
    .reduce((sum, stage) => sum + stage.nominalMs, 0);
  return Math.max(0, now - state.detectedAt - scheduledStart);
}

function activeValue(input: FundingProgressInput, stageIndex: number, now: number): number {
  const { profile } = input;
  const floors = fundingProgressFloors(profile);
  const withinMs = stageElapsedMs(input, stageIndex, now);
  const duration = profile.stages[stageIndex]!.nominalMs;
  const within = Math.min(1 - Math.exp((-FILL_RATE * withinMs) / duration), SEGMENT_LIMIT);
  const floor = floors[stageIndex]!;
  const ceiling = floors[stageIndex + 1]!;
  return Math.min(CAP, floor + (ceiling - floor) * within);
}

function nodeViews(
  profile: FundingProgressProfile,
  activeNodeIndex: number,
  settled: boolean,
): readonly FundingProgressNodeView[] {
  return [
    { key: "started", label: profile.startedNodeLabel },
    ...profile.stages.map((stage) => ({ key: stage.key, label: stage.nodeLabel })),
  ].map((node, index) => ({
    ...node,
    state: settled
      ? "complete"
      : index < activeNodeIndex
        ? "complete"
        : index === activeNodeIndex
          ? "current"
          : "upcoming",
  }));
}

export function fundingProgress(input: FundingProgressInput): FundingProgressView {
  const { profile, state } = input;
  const effectiveNow = state.kind === "failed" ? state.failedAt : input.now;
  const confirmedStageKey =
    state.kind === "active" || state.kind === "failed" ? state.confirmedStageKey : undefined;
  const stageIndex = confirmedStageKey
    ? profile.stages.findIndex(({ key }) => key === confirmedStageKey)
    : -1;
  const settled = state.kind === "settled";
  const routeCompletedAt =
    state.kind === "active" || state.kind === "failed" ? state.routeCompletedAt : undefined;
  const atRouteBoundary =
    routeCompletedAt !== undefined && stageIndex === profile.routeStageCount - 1;
  const activeNodeIndex = settled ? profile.stages.length : Math.max(0, stageIndex + 1);
  const stage = stageIndex < 0 ? undefined : profile.stages[stageIndex];
  const label = settled
    ? profile.settledLabel
    : atRouteBoundary
      ? profile.routeCompletedLabel
      : (stage?.activeLabel ?? profile.waitingLabel);
  const value = settled
    ? 1
    : atRouteBoundary
      ? Math.min(CAP, fundingProgressFloors(profile)[profile.routeStageCount]!)
      : stageIndex < 0
        ? waitingValue(profile, input.createdAt, effectiveNow)
        : activeValue(input, stageIndex, effectiveNow);
  const stageStartedAt =
    state.kind === "active" || state.kind === "failed" ? state.stageStartedAt : undefined;
  const detectedAt =
    state.kind === "active" || state.kind === "failed" ? state.detectedAt : undefined;

  return {
    kind: state.kind,
    value,
    valueNow: Math.round(value * 100),
    label,
    valueText: label,
    activeNodeIndex,
    ...(stage ? { activeStageKey: stage.key } : {}),
    stageElapsedMs: settled
      ? 0
      : Math.max(
          0,
          effectiveNow -
            (atRouteBoundary
              ? routeCompletedAt
              : (stageStartedAt ?? detectedAt ?? input.createdAt)),
        ),
    nodes: nodeViews(profile, activeNodeIndex, settled),
  };
}
