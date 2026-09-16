// The Meld (card / bank) rail's top-ups for the shell's list.

import { computed } from "vue";
import { useFundingProgressClock } from "../composables/useFundingProgressClock";
import { DEPOSIT_EXPIRED_REASON, useSessionStore, type RequestStatus } from "../stores/session";
import {
  parseRequestRefKey,
  requestRefKey,
  requestRefOf,
  type RequestRef,
} from "../utils/request-index";
import {
  meldProgressProvider,
  projectFundingProgress,
  resolveFundingProgressSnapshot,
} from "./progress";
import type { FundingRoute } from "./selection";
import { isMeldSourceId, meldMethodFor, meldSourceIdFor, type MeldMethod } from "./source-ids";
import type { FundingTopUpAdapter } from "./top-up-adapter";
import {
  activeState,
  applyLiveStatus,
  creditedAmount,
  quoteOf,
  type FundingTopUpRecord,
} from "./top-up-projection";
import type { FundingTopUp, FundingTopUpDetails } from "./top-ups";

export type MeldTopUpRecord = FundingTopUpRecord;

const fallbackProfile = meldProgressProvider.createProfile();

/** A fiat top-up's id: the route that paid, then the request's identity (`card:meld-card#3`). */
const topUpId = (route: MeldMethod, ref: RequestRef) => `${route}:${requestRefKey(ref)}`;

/** The request a top-up id names, or null for an id that is not this package's or whose route
 *  and source disagree (`card:meld-bank#1`). */
export function meldRequestRef(id: string): RequestRef | null {
  const match = /^(card|bank):(.*)$/.exec(id);
  if (match === null) return null;
  const ref = parseRequestRefKey(match[2]!);
  if (ref === null || !isMeldSourceId(ref.sourceId)) return null;
  return meldSourceIdFor(match[1] as MeldMethod) === ref.sourceId ? ref : null;
}

/** Replaces the deposit-expired reason on fiat top-ups. */
export const MELD_WINDOW_CLOSED_REASON = "Payment window closed";

function topUpDetails(record: MeldTopUpRecord, method: MeldMethod): FundingTopUpDetails {
  return {
    provider: { label: "Meld", icon: method === "card" ? "/icons/card.svg" : "/icons/bank.svg" },
    method: {
      label: method === "card" ? "Card" : "Bank transfer",
      icon: method === "card" ? "/icons/card.svg" : "/icons/bank.svg",
    },
    ...(record.meldCountry ? { region: record.meldCountry } : {}),
    ...(record.progress?.preDetectionEstimateText
      ? { arrivalEstimate: record.progress.preDetectionEstimateText }
      : {}),
  };
}

export function projectMeldTopUps(
  records: readonly MeldTopUpRecord[],
  statuses: Readonly<Record<string, RequestStatus>>,
  now = Date.now(),
): FundingTopUp[] {
  return records.flatMap((record) => {
    if (record.tradeN === undefined || !isMeldSourceId(record.sourceId)) return [];
    const ref = requestRefOf(record.sourceId, record.tradeN);
    const method = meldMethodFor(record.sourceId);
    const route: FundingRoute = method;
    const status = statuses[requestRefKey(ref)];
    const snapshot = applyLiveStatus(
      resolveFundingProgressSnapshot(record.progress, fallbackProfile, {
        fundedAt: record.funded,
        settledAt: record.settledAt,
      }),
      status,
      now,
    );
    const progress = projectFundingProgress({ snapshot, createdAt: record.startedAt, now });
    const state =
      record.settledAt === undefined
        ? activeState(status, progress, record.failureReason)
        : {
            kind: "settled" as const,
            at: record.settledAt,
            creditedAmount: creditedAmount(record),
          };
    const worded =
      state.kind === "failed" && state.reason === DEPOSIT_EXPIRED_REASON
        ? { ...state, reason: MELD_WINDOW_CLOSED_REASON }
        : state;
    return [
      {
        id: topUpId(method, ref),
        amount: record.amountHuman,
        route,
        startedAt: record.startedAt,
        progress,
        details: topUpDetails(record, method),
        ...quoteOf(record),
        state: worded,
      },
    ];
  });
}

export function useMeldTopUpAdapter(): FundingTopUpAdapter {
  const session = useSessionStore();
  const cadence = computed(() => {
    const cadences = session.requestList.flatMap((record) =>
      !isMeldSourceId(record.sourceId) ||
      record.settledAt !== undefined ||
      record.progress?.settledAt !== undefined ||
      record.progress?.failedAt !== undefined ||
      (record.tradeN !== undefined &&
        session.requestStatus[requestRefKey(requestRefOf(record.sourceId, record.tradeN))]?.kind ===
          "failed")
        ? []
        : [record.progress?.profile.cadenceMs ?? fallbackProfile.cadenceMs],
    );
    return cadences.length === 0 ? null : Math.min(...cadences);
  });
  const now = useFundingProgressClock(cadence);
  return {
    topUps: computed(() =>
      projectMeldTopUps(session.requestList, session.requestStatus, now.value),
    ),
    refresh: () => session.resumeOpenRequests(),
    open: (topUp) => {
      const ref = meldRequestRef(topUp.id);
      return ref === null ? Promise.resolve(false) : session.openRequest(ref);
    },
  };
}
