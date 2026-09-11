import { computed } from "vue";
import { SOURCE_CHAINS } from "~~/lib/config";
import { useFundingProgressClock } from "../composables/useFundingProgressClock";
import { useSessionStore, type RequestStatus } from "../stores/session";
import { networkIcon, tokenIcon } from "../utils/icons";
import {
  parseRequestRefKey,
  requestRefKey,
  requestRefOf,
  type RequestRef,
} from "../utils/request-index";
import { isCryptoSourceId } from "./source-ids";
import {
  chainflipProgressProvider,
  projectFundingProgress,
  resolveFundingProgressSnapshot,
  type FundingProgressSnapshot,
} from "./progress";
import type { FundingTopUpAdapter } from "./top-up-adapter";
import {
  activeState,
  applyLiveStatus,
  creditedAmount,
  quoteOf,
  type FundingTopUpRecord,
} from "./top-up-projection";
import type { FundingTopUp, FundingTopUpDetails } from "./top-ups";

export type ChainflipTopUpRecord = FundingTopUpRecord;

/** A top-up's id: the route, then the request's identity (`crypto:dot-assethub#12`). Parsed by
 *  `chainflipRequestRef`. */
const topUpId = (ref: RequestRef) => `crypto:${requestRefKey(ref)}`;
const fallbackProfile = chainflipProgressProvider.createProfile();

function topUpDetails(
  record: ChainflipTopUpRecord,
  snapshot: FundingProgressSnapshot,
): FundingTopUpDetails {
  const network = record.chain
    ? {
        label: SOURCE_CHAINS.find(({ chain }) => chain === record.chain)?.label ?? record.chain,
        icon: networkIcon(record.chain),
      }
    : undefined;
  const token = record.asset ? { label: record.asset, icon: tokenIcon(record.asset) } : undefined;
  return {
    ...(network === undefined ? {} : { network }),
    ...(token === undefined ? {} : { token }),
    provider: { label: "Chainflip", icon: "/icons/chainflip.png" },
    ...(record.depositAddress ? { depositAddress: record.depositAddress } : {}),
    arrivalEstimate: snapshot.preDetectionEstimateText ?? "≈10 min after your transfer",
  };
}

/** Whether the record belongs to the crypto rail. */
export function isChainflipRecord(record: ChainflipTopUpRecord): boolean {
  return isCryptoSourceId(record.sourceId);
}

export function projectChainflipTopUps(
  records: readonly ChainflipTopUpRecord[],
  statuses: Readonly<Record<string, RequestStatus>>,
  now = Date.now(),
): FundingTopUp[] {
  return records.flatMap((record) => {
    if (record.tradeN === undefined || !isChainflipRecord(record)) return [];
    const ref = requestRefOf(record.sourceId, record.tradeN);
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
    const details = topUpDetails(record, snapshot);
    const state =
      record.settledAt === undefined
        ? activeState(status, progress, record.failureReason, record.refunded)
        : {
            kind: "settled" as const,
            at: record.settledAt,
            creditedAmount: creditedAmount(record),
          };
    return [
      {
        id: topUpId(ref),
        amount: record.amountHuman,
        route: "crypto" as const,
        startedAt: record.startedAt,
        progress,
        details,
        ...quoteOf(record),
        state,
      },
    ];
  });
}

/** The request a top-up id names, or null for an id that is not this package's. */
export function chainflipRequestRef(id: string): RequestRef | null {
  const match = /^crypto:(.*)$/.exec(id);
  if (match === null) return null;
  const ref = parseRequestRefKey(match[1]!);
  return ref !== null && isCryptoSourceId(ref.sourceId) ? ref : null;
}

export function useChainflipTopUpAdapter(): FundingTopUpAdapter {
  const session = useSessionStore();
  const cadence = computed(() => {
    const cadences = session.requestList.flatMap((record) =>
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
      projectChainflipTopUps(session.requestList, session.requestStatus, now.value),
    ),
    refresh: () => session.resumeOpenRequests(),
    open: (topUp) => {
      const ref = chainflipRequestRef(topUp.id);
      return ref === null ? Promise.resolve(false) : session.openRequest(ref);
    },
  };
}
