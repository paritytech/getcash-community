import type { Component, Ref } from "vue";
import type { FundingJourneyStatus } from "./handoff";
import { useMeldJourneyStatus } from "../composables/useMeldJourneyStatus";
import { useChainflipTopUpAdapter } from "./chainflip-top-ups";
import { useMeldTopUpAdapter } from "./meld-top-ups";
import type { FundingRoute, FundingSelection } from "./selection";
import type { FundingTopUpAdapter } from "./top-up-adapter";
import type { FundingTopUp } from "./top-ups";

export interface FundingRouteTopUps {
  useAdapter: () => FundingTopUpAdapter;
  loadStatus: () => Promise<Component>;
}

export interface FundingRoutePackage {
  packageId: string;
  load: () => Promise<Component>;
  topUps?: FundingRouteTopUps;
  /** Composable giving the package's payment status line for the shell's journey. */
  journeyStatus?: () => Readonly<Ref<FundingJourneyStatus | null>>;
}

export type FundingRoutePackages = Partial<Record<FundingRoute, FundingRoutePackage>>;

export type FundingRouteResolution =
  | { kind: "available"; route: FundingRoute; package: FundingRoutePackage }
  | { kind: "unavailable"; route: FundingRoute };

export function resolveFundingRoute(
  packages: FundingRoutePackages,
  route: FundingRoute,
): FundingRouteResolution {
  const routePackage = packages[route];
  return routePackage === undefined
    ? { kind: "unavailable", route }
    : { kind: "available", route, package: routePackage };
}

/** Every distinct package once; a package registered under several routes appears a single time. */
export function uniqueFundingPackages(packages: FundingRoutePackages): FundingRoutePackage[] {
  return [
    ...new Set(Object.values(packages).filter((p): p is FundingRoutePackage => p !== undefined)),
  ];
}

export function availableFundingRoutes(
  packages: FundingRoutePackages,
  routes: readonly FundingRoute[],
): FundingRoute[] {
  return routes.filter((route) => resolveFundingRoute(packages, route).kind === "available");
}

export type FundingPackageLoadResult =
  | { kind: "loaded"; selection: FundingSelection; packageId: string; component: Component }
  | { kind: "unavailable"; selection: FundingSelection }
  | { kind: "failed"; selection: FundingSelection; packageId: string; error: unknown };

export async function loadFundingPackage(
  packages: FundingRoutePackages,
  selection: FundingSelection,
): Promise<FundingPackageLoadResult> {
  const resolution = resolveFundingRoute(packages, selection.route);
  if (resolution.kind === "unavailable") return { kind: "unavailable", selection };

  try {
    return {
      kind: "loaded",
      selection,
      packageId: resolution.package.packageId,
      component: await resolution.package.load(),
    };
  } catch (error: unknown) {
    return { kind: "failed", selection, packageId: resolution.package.packageId, error };
  }
}

export type FundingTopUpPackageLoadResult =
  | { kind: "loaded"; topUp: FundingTopUp; packageId: string; component: Component }
  | { kind: "unavailable"; topUp: FundingTopUp }
  | { kind: "failed"; topUp: FundingTopUp; packageId: string; error: unknown };

export async function loadFundingTopUpPackage(
  packages: FundingRoutePackages,
  topUp: FundingTopUp,
): Promise<FundingTopUpPackageLoadResult> {
  const resolution = resolveFundingRoute(packages, topUp.route);
  if (resolution.kind === "unavailable" || resolution.package.topUps === undefined) {
    return { kind: "unavailable", topUp };
  }

  try {
    return {
      kind: "loaded",
      topUp,
      packageId: resolution.package.packageId,
      component: await resolution.package.topUps.loadStatus(),
    };
  } catch (error: unknown) {
    return { kind: "failed", topUp, packageId: resolution.package.packageId, error };
  }
}

/** The package shared by the card and bank routes. */
const meldPackage = {
  packageId: "@getsome/meld",
  load: () =>
    import("../components/funding/routes/MeldFundingRoute.vue").then(
      ({ default: component }) => component,
    ),
  topUps: {
    useAdapter: useMeldTopUpAdapter,
    loadStatus: () =>
      import("../components/funding/routes/MeldFundingStatusRoute.vue").then(
        ({ default: component }) => component,
      ),
  },
  journeyStatus: useMeldJourneyStatus,
} satisfies FundingRoutePackage;

export const getcashRoutePackages = {
  card: meldPackage,
  bank: meldPackage,
  crypto: {
    packageId: "@getsome/chainflip",
    load: () =>
      import("../components/funding/routes/ChainflipFundingRoute.vue").then(
        ({ default: component }) => component,
      ),
    topUps: {
      useAdapter: useChainflipTopUpAdapter,
      loadStatus: () =>
        import("../components/funding/routes/ChainflipFundingStatusRoute.vue").then(
          ({ default: component }) => component,
        ),
    },
  },
} satisfies FundingRoutePackages;
