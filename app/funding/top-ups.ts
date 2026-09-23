import type { FundingSelectorConfig } from "./config";
import type { FundingProgressProjection } from "./progress";
import type { FundingRoute } from "./selection";

export type FundingTopUpState =
  | { kind: "awaiting-transfer"; status: string }
  | { kind: "finishing"; status: string }
  | { kind: "settled"; at: number; creditedAmount?: string }
  | {
      kind: "failed";
      at?: number;
      reason?: string;
      /** The deposit window closed with nothing paid, rather than a payment going wrong. A journey
       *  opened from history has only the record to tell the two endings apart. */
      expired?: boolean;
      refunded?: boolean;
      /** What came back and the transaction that returned it, for a refund with no live request
       *  left to ask. Absent on records written before either was kept. */
      refundAmount?: string;
      refundTxRef?: string;
    };

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

/** The rail's quote as the record kept it: the charge, the fee, and the components the fee
 *  breakdown itemizes. Persisted with the request, so the split survives the session. */
export type StoredQuote = Readonly<{
  amount: string;
  symbol: string;
  fee?: string;
  /** The provider that priced the request. */
  provider?: string;
  transactionFee?: string;
  networkFee?: string;
  partnerFee?: string;
  chainFee?: string;
}>;

export type FundingTopUp = Readonly<{
  id: string;
  amount: string;
  route: FundingRoute;
  startedAt: number;
  progress: FundingProgressProjection;
  details?: FundingTopUpDetails;
  /** What the buyer pays as the rail quoted it, for the journey's money row when the request is
   *  not (yet) live in the store — and for the fee breakdown behind it, which is why the fee's
   *  own components ride along. */
  quote?: StoredQuote;
  /** The rail is retrying or running late: the list draws the status line amber. Never terminal.
   *  Read off the record's own `rail.delayed`, which the foreground journey reads too, so the
   *  list and the journey never disagree about the same request. */
  delayed?: boolean;
  /** The request this top-up is, as the store names it. Lets a screen reach the request's own
   *  derived material — the refund key — without a live world behind it. */
  request?: Readonly<{ sourceId: string; tradeN: number }>;
  /** How many of the journey's markers the record counted, on this route's own scale. The journey
   *  opened from history has no live request to count them from, and a top-up that was paid and
   *  converted before it failed must not redraw as though it never started. */
  journeyDone?: number;
  /** The rail's own id for the payment, as the buyer would quote it to support. Persisted with
   *  the request, so a journey opened long after the session that made it still carries it. */
  reference?: string;
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
  delayed?: boolean;
}>;

export type InProgressFundingTopUp = FundingTopUpBase &
  Readonly<{
    state:
      | { kind: "awaiting-transfer"; status: string; detail: "Tap for the details" }
      | { kind: "finishing"; status: string; detail: string };
  }>;

export type SettledFundingTopUp = FundingTopUpBase &
  Readonly<{
    state: { kind: "settled"; status: string; at: number; creditedAmount: string };
  }>;

export type FailedFundingTopUp = FundingTopUpBase &
  Readonly<{
    state: {
      kind: "failed";
      status: "Payment failed" | "Refunded" | "Expired";
      at: number;
      reason?: string;
    };
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

/** The words the rows use for a finished request: a top-up is added, a withdrawal is sent. */
export interface FundingTopUpWording {
  settled: string;
}

const TOP_UP_WORDING: FundingTopUpWording = { settled: "Added" };

/** The words the shell's list screens use around the rows. */
export interface FundingListWording {
  /** The pending screen's toolbar title. */
  pendingTitle: string;
  /** The line the history screen shows when there is nothing to list. */
  emptyHistory: string;
}

export const TOP_UP_LIST_WORDING: FundingListWording = {
  pendingTitle: "Top-up in progress",
  emptyHistory: "Nothing here yet. Your top-ups will appear as you make them.",
};

export function projectFundingTopUps(
  topUps: readonly FundingTopUp[],
  config: FundingSelectorConfig,
  wording: FundingTopUpWording = TOP_UP_WORDING,
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
      ...(topUp.delayed === undefined ? {} : { delayed: topUp.delayed }),
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
            status: wording.settled,
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
            // "Payment failed" claims a payment existed and went wrong; an expiry means nobody
            // ever paid, and the row must not contradict the journey it opens.
            status: topUp.state.expired
              ? "Expired"
              : topUp.state.refunded
                ? "Refunded"
                : "Payment failed",
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
