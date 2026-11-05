// The withdrawal timelines the app shows, and the view each showed last, so that a withdrawal
// shown on two screens never moves back on either.

import { requestRefKey } from "../../utils/request-index";
import type { WithdrawalRecord } from "../../funding/requests/model";
import type { TimelineView } from "../../funding/timeline/types";
import { withdrawalTimeline, type WithdrawalTimeline } from "./withdrawal";

export type WithdrawalTimelineOf = (record: WithdrawalRecord, now: number) => WithdrawalTimeline;

/** Evaluates withdrawal timelines in memory for one app session. */
export function createWithdrawalTimelines(): WithdrawalTimelineOf {
  const shown = new Map<string, TimelineView>();
  return (record, now) => {
    const key = requestRefKey(record.ref);
    const timeline = withdrawalTimeline(record, { now, previous: shown.get(key) });
    if (timeline.view !== undefined) shown.set(key, timeline.view);
    return timeline;
  };
}
