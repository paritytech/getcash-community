import type {
  FundingProgressProfile,
  FundingProgressProfileOptions,
  FundingProgressProvider,
  FundingProgressRouteDefinition,
  FundingProgressSharedDefinition,
  FundingProgressStage,
} from "./types";

function positive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
}

function scaleIngress(
  stages: readonly FundingProgressStage[],
  durationMs: number | undefined,
): readonly FundingProgressStage[] {
  if (durationMs === undefined) return stages.map((stage) => ({ ...stage }));
  positive(durationMs, "ingress duration");
  const total = stages.reduce((sum, stage) => sum + stage.nominalMs, 0);
  return stages.map((stage) => ({
    ...stage,
    nominalMs: durationMs * (stage.nominalMs / total),
  }));
}

export function composeFundingProgressProfile(
  route: FundingProgressRouteDefinition,
  shared: FundingProgressSharedDefinition,
  options: FundingProgressProfileOptions = {},
): FundingProgressProfile {
  if (!route.id.trim()) throw new Error("progress profile id is required");
  if (!Number.isInteger(route.version) || route.version < 1) {
    throw new Error("progress profile version must be a positive integer");
  }
  positive(route.expectedUserDelayMs, "expected user delay");
  positive(route.cadenceMs, "progress cadence");
  if (route.stages.length === 0) throw new Error("progress profile needs a route stage");
  if (shared.stages.length === 0) throw new Error("progress profile needs a shared stage");

  const stages = [...scaleIngress(route.stages, options.ingressDurationMs), ...shared.stages].map(
    (stage) => {
      if (!stage.key.trim()) throw new Error("progress stage key is required");
      positive(stage.nominalMs, `nominal duration for ${stage.key}`);
      return Object.freeze({ ...stage });
    },
  );
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
    settledLabel: "Ready to spend",
    stages: Object.freeze(stages),
  });
}

export function createFundingProgressProvider(
  route: FundingProgressRouteDefinition,
  shared: FundingProgressSharedDefinition,
): FundingProgressProvider {
  return Object.freeze({
    id: route.id,
    version: route.version,
    createProfile: (options?: FundingProgressProfileOptions) =>
      composeFundingProgressProfile(route, shared, options),
    observeRoute: route.observe,
  });
}

export function createFundingProgressRegistry(providers: readonly FundingProgressProvider[]) {
  const byId = new Map<string, FundingProgressProvider>();
  for (const provider of providers) {
    if (byId.has(provider.id)) throw new Error(`duplicate progress provider '${provider.id}'`);
    byId.set(provider.id, provider);
  }

  return Object.freeze({
    get(id: string): FundingProgressProvider | undefined {
      return byId.get(id);
    },
    require(id: string): FundingProgressProvider {
      const provider = byId.get(id);
      if (!provider) throw new Error(`unknown progress provider '${id}'`);
      return provider;
    },
    list(): readonly FundingProgressProvider[] {
      return [...byId.values()];
    },
  });
}
