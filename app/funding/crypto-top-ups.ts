import { computed } from "vue";
import { chainLabel } from "~~/lib/config";
import { useFundingProgressClock } from "../composables/useFundingProgressClock";
import { useRequestsStore } from "../stores/requests";
import { useSessionStore } from "../stores/session";
import { networkIcon, tokenIcon } from "../utils/icons";
import { parseRequestRefKey, requestRefKey, type RequestRef } from "../utils/request-index";
import { isCryptoSourceId } from "./source-ids";
import type { TopUpRecord } from "./requests/model";
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

export type CryptoTopUpRecord = FundingTopUpRecord;

/** A top-up's id: the route, then the request's identity (`crypto:dot-assethub#12`). Parsed by
 *  `cryptoRequestRef`. */
export const cryptoTopUpId = (ref: RequestRef) => `crypto:${requestRefKey(ref)}`;

/** The rows whose progress no longer moves on its own. */
const FINISHED = new Set<TopUpRecord["status"]["kind"]>(["settled", "failed", "expired"]);

function topUpDetails(record: CryptoTopUpRecord): FundingTopUpDetails {
  const network = record.chain
    ? {
        label: chainLabel(record.chain),
        icon: networkIcon(record.chain),
      }
    : undefined;
  // A direct deposit has no provider to name.
  const token = record.asset ? { label: record.asset, icon: tokenIcon(record.asset) } : undefined;
  return {
    ...(network === undefined ? {} : { network }),
    ...(token === undefined ? {} : { token }),
    ...(record.depositAddress ? { depositAddress: record.depositAddress } : {}),
  };
}

/** Whether the record belongs to the crypto rail. */
export function isCryptoRecord(record: Pick<TopUpRecord, "ref">): boolean {
  return isCryptoSourceId(record.ref.sourceId);
}

export function projectCryptoTopUps(
  records: readonly TopUpRecord[],
  now = Date.now(),
  timelineOf: TopUpTimelineOf = createTopUpTimelines(),
): FundingTopUp[] {
  return records.flatMap((record) => {
    if (!isCryptoRecord(record)) return [];
    const { ref } = record;
    const timeline = timelineOf(record, now);
    const progress = listProgress(timeline);
    return [
      {
        id: cryptoTopUpId(ref),
        amount: record.amountHuman,
        route: "crypto" as const,
        startedAt: record.startedAt,
        progress,
        ...(timeline === undefined ? {} : { timeline }),
        details: topUpDetails(record),
        ...quoteOf(record),
        state: rowStateOf(record, listHeadline("crypto", timeline).text, now),
      },
    ];
  });
}

/** The request a top-up id names, or null for an id that is not this package's. */
export function cryptoRequestRef(id: string): RequestRef | null {
  const match = /^crypto:(.*)$/.exec(id);
  if (match === null) return null;
  const ref = parseRequestRefKey(match[1]!);
  return ref !== null && isCryptoSourceId(ref.sourceId) ? ref : null;
}

export function useCryptoTopUpAdapter(): FundingTopUpAdapter {
  const session = useSessionStore();
  const requests = useRequestsStore();
  const now = useFundingProgressClock(() =>
    requests.openTopUps.some((record) => !FINISHED.has(record.status.kind))
      ? TIMELINE_CADENCE_MS
      : null,
  );
  return {
    topUps: computed(() =>
      projectCryptoTopUps(requests.openTopUps, now.value, requests.topUpTimelineOf),
    ),
    refresh: () => session.resumeOpenRequests("boot"),
    open: (topUp) => {
      const ref = cryptoRequestRef(topUp.id);
      return ref === null ? Promise.resolve(false) : session.openRequest(ref);
    },
  };
}
