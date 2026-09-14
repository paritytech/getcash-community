import { computed } from "vue";
import { SOURCE_CHAINS } from "~~/lib/config";
import { useFundingProgressClock } from "../composables/useFundingProgressClock";
import { useRequestsStore } from "../stores/requests";
import { useSessionStore } from "../stores/session";
import { networkIcon, tokenIcon } from "../utils/icons";
import { parseRequestRefKey, requestRefKey, type RequestRef } from "../utils/request-index";
import { isCryptoSourceId } from "./source-ids";
import { projectFundingProgress, type FundingProgressSnapshot } from "./progress";
import type { RequestRecord } from "./requests/model";
import { rowStateOf } from "./requests/views";
import type { FundingTopUpAdapter } from "./top-up-adapter";
import type { FundingTopUpRecord } from "./top-up-projection";
import type { FundingTopUp, FundingTopUpDetails } from "./top-ups";

export type ChainflipTopUpRecord = FundingTopUpRecord;

/** A top-up's id: the route, then the request's identity (`crypto:dot-assethub#12`). Parsed by
 *  `chainflipRequestRef`. */
const topUpId = (ref: RequestRef) => `crypto:${requestRefKey(ref)}`;

/** The rows whose progress no longer moves on its own. */
const FINISHED = new Set<RequestRecord["status"]["kind"]>(["settled", "failed", "expired"]);

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
export function isChainflipRecord(record: Pick<RequestRecord, "ref">): boolean {
  return isCryptoSourceId(record.ref.sourceId);
}

export function projectChainflipTopUps(
  records: readonly RequestRecord[],
  now = Date.now(),
): FundingTopUp[] {
  return records.flatMap((record) => {
    if (!isChainflipRecord(record)) return [];
    const { ref, progress: snapshot } = record;
    const progress = projectFundingProgress({ snapshot, createdAt: record.startedAt, now });
    return [
      {
        id: topUpId(ref),
        amount: record.amountHuman,
        route: "crypto" as const,
        startedAt: record.startedAt,
        progress,
        details: topUpDetails(record, snapshot),
        ...(record.sourceAmount && record.sourceSymbol
          ? { quote: { amount: record.sourceAmount, symbol: record.sourceSymbol } }
          : {}),
        state: rowStateOf(record, progress),
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
  const requests = useRequestsStore();
  const cadence = computed(() => {
    const cadences = requests.openRecords.flatMap((record) =>
      FINISHED.has(record.status.kind) ? [] : [record.progress.profile.cadenceMs],
    );
    return cadences.length === 0 ? null : Math.min(...cadences);
  });
  const now = useFundingProgressClock(cadence);
  return {
    topUps: computed(() => projectChainflipTopUps(requests.openRecords, now.value)),
    refresh: () => session.resumeOpenRequests("boot"),
    open: (topUp) => {
      const ref = chainflipRequestRef(topUp.id);
      return ref === null ? Promise.resolve(false) : session.openRequest(ref);
    },
  };
}
