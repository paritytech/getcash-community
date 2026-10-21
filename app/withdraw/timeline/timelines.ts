// The withdrawal timelines the app shows, and the view each showed last, so that a withdrawal
// shown on two screens never moves back on either.

import { requestRefKey } from "../../utils/request-index";
import type { WithdrawalRecord } from "../../funding/requests/model";
import { stepSince } from "../../funding/timeline/live";
import type { TimelineView } from "../../funding/timeline/types";
import { withdrawalTimeline, type WithdrawalTimeline } from "./withdrawal";

export type WithdrawalTimelineOf = (record: WithdrawalRecord, now: number) => WithdrawalTimeline;

/** What this session watched of one withdrawal: the view shown last and when its step began. */
interface Watch {
  readonly view: TimelineView;
  readonly stepSince: number;
}

/** Evaluates withdrawal timelines in memory for one app session. */
export function createWithdrawalTimelines(): WithdrawalTimelineOf {
  const shown = new Map<string, Watch>();
  return (record, now) => {
    const key = requestRefKey(record.ref);
    const watch = shown.get(key);
    const timeline = withdrawalTimeline(record, {
      now,
      previous: watch?.view,
      stepSince: watch?.stepSince ?? now,
    });
    const { view } = timeline;
    if (view !== undefined) {
      shown.set(key, {
        view,
        stepSince: stepSince(view, watch?.view, watch?.stepSince ?? now, now),
      });
    }
    return timeline;
  };
}
