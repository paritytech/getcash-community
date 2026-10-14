import type {
  FundingProgressProfile,
  FundingProgressRouteDefinition,
  FundingProgressSharedDefinition,
} from "./types";

function positive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
}

export function composeFundingProgressProfile(
  route: FundingProgressRouteDefinition,
  shared: FundingProgressSharedDefinition,
): FundingProgressProfile {
  if (!route.id.trim()) throw new Error("progress profile id is required");
  if (!Number.isInteger(route.version) || route.version < 1) {
    throw new Error("progress profile version must be a positive integer");
  }
  positive(route.expectedUserDelayMs, "expected user delay");
  positive(route.cadenceMs, "progress cadence");
  if (route.stages.length === 0) throw new Error("progress profile needs a route stage");
  if (shared.stages.length === 0) throw new Error("progress profile needs a shared stage");

  const stages = [...route.stages, ...shared.stages].map((stage) => {
    if (!stage.key.trim()) throw new Error("progress stage key is required");
    positive(stage.nominalMs, `nominal duration for ${stage.key}`);
    return Object.freeze({ ...stage });
  });
  if (stages.length === 0) throw new Error("progress profile needs at least one stage");

  const keys = new Set(stages.map(({ key }) => key));
  if (keys.size !== stages.length || keys.has("started")) {
    throw new Error("progress stage keys must be unique and cannot use 'started'");
  }

  return Object.freeze({
    id: route.id,
    version: route.version,
    expectedUserDelayMs: route.expectedUserDelayMs,
    cadenceMs: route.cadenceMs,
    routeStageCount: route.stages.length,
    startedNodeLabel: route.startedNodeLabel ?? "Started",
    waitingLabel: route.waitingLabel ?? "Waiting for your transfer",
    routeCompletedLabel: route.routeCompletedLabel ?? "Payment received",
    settledLabel: route.settledLabel ?? "Ready to spend",
    stages: Object.freeze(stages),
  });
}
