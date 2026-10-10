// The timelines the app shows: the route of each top-up by its source, and the view each showed
// last, so that a top-up shown on two screens never moves back on either.

import { requestRefKey } from "../../utils/request-index";
import type { TopUpRecord } from "../requests/model";
import { isCryptoSourceId, isMeldSourceId, meldMethodFor, type MeldMethod } from "../source-ids";
import { chainflipRoute } from "./chainflip";
import { directRoute } from "./direct";
import { meldBankRoute, meldCardRoute } from "./meld";
import { polkadotMilestones } from "./polkadot";
import type { TimelineRoute } from "./route";
import { topUpTimeline, type TopUpTimeline } from "./top-up";
import type { TimelineView } from "./types";

/** How often a shown timeline is evaluated: each second, for time-moved lines and countdowns. */
export const TIMELINE_CADENCE_MS = 1_000;

const MELD_ROUTES: Readonly<Record<MeldMethod, TimelineRoute>> = {
  card: meldCardRoute,
  bank: meldBankRoute,
};

/** The route of a top-up from its source: Meld card or bank, a direct Asset Hub deposit, or else
 *  a Chainflip swap. */
export function timelineRouteOf(sourceId: string | undefined): TimelineRoute {
  if (isMeldSourceId(sourceId)) return MELD_ROUTES[meldMethodFor(sourceId)];
  return isCryptoSourceId(sourceId) ? directRoute : chainflipRoute;
}

/** The timeline opens with the deposit: the route's Started, or a later fact that implies it. */
function opened(record: TopUpRecord, route: TimelineRoute): boolean {
  const facts = [
    ...Object.values(route.milestones(record)),
    ...Object.values(polkadotMilestones(record)),
  ];
  return facts.some((fact) => fact !== undefined);
}

/** A top-up's timeline at `now`; absent until it opens. */
export type TopUpTimelineOf = (record: TopUpRecord, now: number) => TopUpTimeline | undefined;

/** Evaluates timelines in memory for one app session. Each top-up is watched from its first
 *  evaluation, and its line never falls behind the view it showed last. */
export function createTopUpTimelines(): TopUpTimelineOf {
  const shown = new Map<string, { watchingSince: number; previous?: TimelineView }>();
  return (record, now) => {
    const key = requestRefKey(record.ref);
    const { watchingSince, previous } = shown.get(key) ?? { watchingSince: now };
    const route = timelineRouteOf(record.ref.sourceId);
    if (!opened(record, route)) {
      shown.set(key, { watchingSince });
      return undefined;
    }
    const timeline = topUpTimeline(record, route, { now, watchingSince, previous });
    shown.set(key, { watchingSince, previous: timeline.view });
    return timeline;
  };
}
