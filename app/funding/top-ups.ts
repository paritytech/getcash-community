import type { FundingSelectorConfig } from "./config";
import type { FundingProgressProjection } from "./progress";
import type { FundingRoute } from "./selection";

export type FundingTopUpState =
  | { kind: "awaiting-transfer"; status: string }
  | { kind: "finishing"; status: string }
  | { kind: "settled"; at: number; creditedAmount?: string }
  | { kind: "failed"; at?: number; reason?: string; refunded?: boolean };

export type FundingTopUpDetail = Readonly<{
  label: string;
  icon: string;
}>;

export type FundingTopUpDetails = Readonly<{
  network?: FundingTopUpDetail;
  token?: FundingTopUpDetail;
  provider?: FundingTopUpDetail;
  /** How the buyer paid, for a fiat rail ("Card", "Bank transfer"). */
  method?: FundingTopUpDetail;
  /** The buyer's region, for a fiat rail (an ISO country code). */
  region?: string;
  depositAddress?: string;
  arrivalEstimate?: string;
}>;

export type FundingTopUp = Readonly<{
  id: string;
  amount: string;
  route: FundingRoute;
  startedAt: number;
  progress: FundingProgressProjection;
  details?: FundingTopUpDetails;
  /** What the buyer pays as the rail quoted it, for the journey's Fees/Total rows when the
   *  request is not (yet) live in the store. */
  quote?: Readonly<{ amount: string; symbol: string; fee?: string }>;
  state: FundingTopUpState;
}>;

type FundingTopUpBase = Readonly<{
  id: string;
  amount: string;
  route: FundingRoute;
  routeLabel: string;
  routeIcon: string;
  estimate: string;
  startedAt: number;
  progress: FundingProgressProjection;
  details?: FundingTopUpDetails;
}>;

export type InProgressFundingTopUp = FundingTopUpBase &
  Readonly<{
    state:
      | { kind: "awaiting-transfer"; status: string; detail: "Tap for the details" }
      | { kind: "finishing"; status: string; detail: string };
  }>;

export type SettledFundingTopUp = FundingTopUpBase &
  Readonly<{
    state: { kind: "settled"; status: "Added"; at: number; creditedAmount: string };
  }>;

export type FailedFundingTopUp = FundingTopUpBase &
  Readonly<{
    state: { kind: "failed"; status: "Failed" | "Deposit returned"; at: number; reason?: string };
  }>;

export type PastFundingTopUp = SettledFundingTopUp | FailedFundingTopUp;

export type FundingTopUpSections = Readonly<{
  inProgress: readonly InProgressFundingTopUp[];
  past: readonly PastFundingTopUp[];
  latestSettled: SettledFundingTopUp | null;
}>;

export function hasFundingPendingContent(
  inProgress: readonly InProgressFundingTopUp[],
  latestSettled: SettledFundingTopUp | null,
): boolean {
  return inProgress.length > 0 || latestSettled !== null;
}

export function projectFundingTopUps(
  topUps: readonly FundingTopUp[],
  config: FundingSelectorConfig,
): FundingTopUpSections {
  const inProgress: InProgressFundingTopUp[] = [];
  const past: PastFundingTopUp[] = [];

  for (const topUp of topUps) {
    const route = config.routes.find(({ id }) => id === topUp.route);
    const base: FundingTopUpBase = {
      id: topUp.id,
      amount: topUp.amount,
      route: topUp.route,
      routeLabel: route?.label ?? topUp.route,
      routeIcon: route?.icon ?? "",
      estimate: route?.estimate ?? "",
      startedAt: topUp.startedAt,
      progress: topUp.progress,
      ...(topUp.details === undefined ? {} : { details: topUp.details }),
    };

    switch (topUp.state.kind) {
      case "awaiting-transfer":
        inProgress.push({
          ...base,
          state: {
            ...topUp.state,
            detail: "Tap for the details",
          },
        });
        break;
      case "finishing":
        inProgress.push({
          ...base,
          state: {
            ...topUp.state,
            detail: `Ready ${route?.estimate ?? ""}`.trimEnd(),
          },
        });
        break;
      case "settled":
        past.push({
          ...base,
          state: {
            kind: "settled",
            status: "Added",
            at: topUp.state.at,
            creditedAmount: topUp.state.creditedAmount ?? topUp.amount,
          },
        });
        break;
      case "failed":
        past.push({
          ...base,
          state: {
            kind: "failed",
            status: topUp.state.refunded ? "Deposit returned" : "Failed",
            at: topUp.state.at ?? topUp.startedAt,
            ...(topUp.state.reason === undefined ? {} : { reason: topUp.state.reason }),
          },
        });
        break;
    }
  }

  inProgress.sort((a, b) => b.startedAt - a.startedAt);
  past.sort((a, b) => b.state.at - a.state.at);
  const latestSettled = past.find(
    (topUp): topUp is SettledFundingTopUp => topUp.state.kind === "settled",
  );
  return { inProgress, past, latestSettled: latestSettled ?? null };
}
