export interface FundingProgressStage {
  key: string;
  nodeLabel: string;
  activeLabel: string;
  nominalMs: number;
}

export interface FundingProgressProfile {
  id: string;
  version: number;
  expectedUserDelayMs: number;
  cadenceMs: number;
  routeStageCount: number;
  startedNodeLabel: string;
  waitingLabel: string;
  routeCompletedLabel: string;
  settledLabel: string;
  stages: readonly FundingProgressStage[];
}

export interface FundingProgressSnapshot {
  schemaVersion: number;
  profile: FundingProgressProfile;
  confirmedStageKey?: string;
  latestRouteStatus?: string;
  routeCompletedAt?: number;
  detectedAt?: number;
  stageTimestamps: Readonly<Record<string, number>>;
  failedAt?: number;
  settledAt?: number;
  preDetectionEstimateText?: string;
  estimatedCompletionAt?: number;
}

export interface FundingProgressSnapshotOptions {
  confirmedStageKey?: string;
  latestRouteStatus?: string;
  routeCompletedAt?: number;
  detectedAt?: number;
  stageTimestamps?: Readonly<Record<string, number>>;
  failedAt?: number;
  settledAt?: number;
  preDetectionEstimateText?: string;
  estimatedCompletionAt?: number;
}

export interface LegacyFundingProgressFacts {
  fundedAt?: number;
  settledAt?: number;
}

export type FundingProgressObservation =
  | { kind: "waiting" }
  | { kind: "stage"; stageKey: string }
  | { kind: "hold" }
  | { kind: "route-complete" }
  | { kind: "failed" }
  | { kind: "settled" };

export interface FundingProgressSignal {
  observation: FundingProgressObservation;
  routeStatus?: string;
}

export interface FundingProgressEvent extends FundingProgressSignal {
  at: number;
}

type ActiveProgressState = Readonly<{
  kind: "active";
  confirmedStageKey: string;
  detectedAt?: number;
  stageStartedAt?: number;
  routeCompletedAt?: number;
}>;

type FailedProgressState = Readonly<{
  kind: "failed";
  failedAt: number;
  confirmedStageKey?: string;
  detectedAt?: number;
  stageStartedAt?: number;
  routeCompletedAt?: number;
}>;

export type FundingProgressState =
  | Readonly<{ kind: "waiting" }>
  | ActiveProgressState
  | Readonly<{ kind: "settled" }>
  | FailedProgressState;

export interface FundingProgressInput {
  profile: FundingProgressProfile;
  state: FundingProgressState;
  createdAt: number;
  now: number;
}

export type FundingProgressNodeState = "complete" | "current" | "upcoming";

export interface FundingProgressNodeView {
  key: string;
  label: string;
  state: FundingProgressNodeState;
}

export interface FundingProgressView {
  kind: FundingProgressState["kind"];
  value: number;
  valueNow: number;
  label: string;
  valueText: string;
  activeNodeIndex: number;
  activeStageKey?: string;
  stageElapsedMs: number;
  nodes: readonly FundingProgressNodeView[];
}

export interface FundingProgressProjection {
  view: FundingProgressView;
  estimateText: string;
  cadenceMs: number;
  detectedAt?: number;
  failedAt?: number;
  settledAt?: number;
  stageTimestamps: Readonly<Record<string, number>>;
}

export interface FundingProgressProjectionInput {
  snapshot: FundingProgressSnapshot;
  createdAt: number;
  now: number;
}

export interface FundingProgressProfileOptions {
  ingressDurationMs?: number;
}

export interface FundingProgressRouteDefinition {
  id: string;
  version: number;
  expectedUserDelayMs: number;
  cadenceMs: number;
  startedNodeLabel?: string;
  /** The waiting-state label. Defaults to "Waiting for your transfer". */
  waitingLabel?: string;
  /** The node label once the rail's own leg is done. Defaults to "Payment received". */
  routeCompletedLabel?: string;
  stages: readonly FundingProgressStage[];
  observe(status: string): FundingProgressObservation;
}

export interface FundingProgressSharedDefinition {
  stages: readonly FundingProgressStage[];
}

export interface FundingProgressProvider {
  id: string;
  version: number;
  createProfile(options?: FundingProgressProfileOptions): FundingProgressProfile;
  observeRoute(status: string): FundingProgressObservation;
}
