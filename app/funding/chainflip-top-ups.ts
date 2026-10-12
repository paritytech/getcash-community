import { computed } from "vue";
import { FUNDING_CHAINS } from "~~/lib/config";
import { useFundingProgressClock } from "../composables/useFundingProgressClock";
import { useRequestsStore } from "../stores/requests";
import { useSessionStore } from "../stores/session";
import { networkIcon, tokenIcon } from "../utils/icons";
import { parseRequestRefKey, requestRefKey, type RequestRef } from "../utils/request-index";
import { CRYPTO_SOURCE_ID, isCryptoSourceId } from "./source-ids";
import { effectiveSourceId, railProviderOf, type TopUpRecord } from "./requests/model";
import { rowStateOf } from "./requests/views";
import { listHeadline, listProgress } from "./timeline/list";
import {
  createTopUpTimelines,
  TIMELINE_CADENCE_MS,
  type TopUpTimelineOf,
} from "./timeline/timelines";
import type { FundingTopUpAdapter } from "./top-up-adapter";
import { quoteOf, type FundingTopUpRecord } from "./top-up-projection";
import type { FundingTopUp, FundingTopUpDetails } from "./top-ups";

export type ChainflipTopUpRecord = FundingTopUpRecord;

/** A top-up's id: the route, then the request's identity (`crypto:dot-assethub#12`). Parsed by
 *  `chainflipRequestRef`. */
export const chainflipTopUpId = (ref: RequestRef) => `crypto:${requestRefKey(ref)}`;

/** The rows whose progress no longer moves on its own. */
const FINISHED = new Set<TopUpRecord["status"]["kind"]>(["settled", "failed", "expired"]);

function topUpDetails(record: ChainflipTopUpRecord): FundingTopUpDetails {
  const network = record.chain
    ? {
        label: FUNDING_CHAINS.find(({ chain }) => chain === record.chain)?.label ?? record.chain,
        icon: networkIcon(record.chain),
      }
    : undefined;
  const token = record.asset ? { label: record.asset, icon: tokenIcon(record.asset) } : undefined;
  // Only a swap through Chainflip has a provider to name; a direct deposit has none.
  const provider =
    railProviderOf(record.sourceId ?? CRYPTO_SOURCE_ID) === "chainflip"
      ? { label: "Chainflip", icon: "/icons/chainflip.png" }
      : undefined;
  return {
    ...(network === undefined ? {} : { network }),
    ...(token === undefined ? {} : { token }),
    ...(provider === undefined ? {} : { provider }),
    ...(record.depositAddress ? { depositAddress: record.depositAddress } : {}),
  };
}

/** Whether the record belongs to the crypto rail. */
export function isChainflipRecord(record: Pick<TopUpRecord, "ref">): boolean {
  return isCryptoSourceId(record.ref.sourceId);
}

export function projectChainflipTopUps(
  records: readonly TopUpRecord[],
  now = Date.now(),
  timelineOf: TopUpTimelineOf = createTopUpTimelines(),
): FundingTopUp[] {
  return records.flatMap((record) => {
    if (!isChainflipRecord(record)) return [];
    const { ref } = record;
    const timeline = timelineOf(record, now);
    const progress = listProgress(timeline);
    return [
      {
        id: chainflipTopUpId(ref),
        amount: record.amountHuman,
        route: "crypto" as const,
        startedAt: record.startedAt,
        progress,
        ...(timeline === undefined ? {} : { timeline }),
        details: topUpDetails(record),
        ...quoteOf(record),
        // The request's own identity, so a refund can be walked back to its key with no world.
        request: { sourceId: effectiveSourceId(ref), tradeN: ref.tradeN },
        state: rowStateOf(record, listHeadline("crypto", timeline).text),
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
  const now = useFundingProgressClock(() =>
    requests.openTopUps.some((record) => !FINISHED.has(record.status.kind))
      ? TIMELINE_CADENCE_MS
      : null,
  );
  return {
    topUps: computed(() =>
      projectChainflipTopUps(requests.openTopUps, now.value, requests.topUpTimelineOf),
    ),
    refresh: () => session.resumeOpenRequests("boot"),
    open: (topUp) => {
      const ref = chainflipRequestRef(topUp.id);
      return ref === null ? Promise.resolve(false) : session.openRequest(ref);
    },
  };
}
