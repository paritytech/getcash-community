// The timelines the app shows: the route of each top-up, and the view each showed
// last, so that a top-up shown on two screens never moves back on either.

import { requestRefKey } from "../../utils/request-index";
import { isDirectDeposit, type TopUpRecord } from "../requests/model";
import { isMeldSourceId, meldMethodFor, type MeldMethod } from "../source-ids";
import { chainflipRoute } from "./chainflip";
import { directRoute } from "./direct";
import { meldBankRoute, meldCardRoute } from "./meld";
import type { TimelineRoute } from "./route";
import { topUpTimeline, type TopUpTimeline } from "./top-up";
import type { TimelineView } from "./types";

/** How often a shown timeline is evaluated: each second, for time-moved lines and countdowns. */
export const TIMELINE_CADENCE_MS = 1_000;

/** Evaluations further apart than this mean the app was not running in between. */
const MAX_EVALUATION_GAP_MS = 5 * TIMELINE_CADENCE_MS;

const MELD_ROUTES: Readonly<Record<MeldMethod, TimelineRoute>> = {
  card: meldCardRoute,
  bank: meldBankRoute,
};

/** The route of a top-up: Meld card or bank by its source, a direct deposit by the network paid
 *  from, or else a Chainflip swap, which runs under the Asset Hub source it arrives as. */
export function timelineRouteOf(record: Pick<TopUpRecord, "chain" | "ref">): TimelineRoute {
  const { sourceId } = record.ref;
  if (isMeldSourceId(sourceId)) return MELD_ROUTES[meldMethodFor(sourceId)];
  return isDirectDeposit(record) ? directRoute : chainflipRoute;
}

/** A top-up's timeline at `now`; absent until it opens, unless the top-up ended before. */
export type TopUpTimelineOf = (record: TopUpRecord, now: number) => TopUpTimeline | undefined;

/** What this session watched of one top-up. */
interface Watch {
  readonly watchingSince: number;
  readonly previous?: TimelineView;
  /** The fresh read time, in total, that the funds the provider sent went unseen. */
  readonly sentUnseenMs: number;
  /** When the last evaluation found the sent funds unseen with fresh reads. */
  readonly awaitingSince?: number;
}

/** Evaluates timelines in memory for one app session. Each top-up is watched from its first
 *  evaluation, and its line never falls behind the view it showed last. */
export function createTopUpTimelines(): TopUpTimelineOf {
  const shown = new Map<string, Watch>();
  return (record, now) => {
    const key = requestRefKey(record.ref);
    const { watchingSince, previous, sentUnseenMs, awaitingSince } = shown.get(key) ?? {
      watchingSince: now,
      sentUnseenMs: 0,
    };
    const route = timelineRouteOf(record);
    const timeline = topUpTimeline(record, route, { now, watchingSince, previous, sentUnseenMs });
    if (timeline === undefined) {
      shown.set(key, { watchingSince, sentUnseenMs });
      return undefined;
    }
    const awaiting = timeline.awaitingSentFunds === true;
    const awaited =
      awaiting && awaitingSince !== undefined
        ? Math.min(Math.max(now - awaitingSince, 0), MAX_EVALUATION_GAP_MS)
        : 0;
    shown.set(key, {
      watchingSince,
      previous: timeline.view,
      sentUnseenMs: sentUnseenMs + awaited,
      ...(awaiting ? { awaitingSince: now } : {}),
    });
    return timeline;
  };
}
