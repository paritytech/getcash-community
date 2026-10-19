// The withdrawal's timeline: from the payment out of the balance to the funds at the destination,
// on the shared timeline model. Absent until the CASH reaches the key, unless the withdrawal
// ended before.

import { timelineView } from "../../funding/timeline/model";
import { normal, type TimelineMessage } from "../../funding/timeline/route";
import type { TimelineView } from "../../funding/timeline/types";
import { isWithdrawalSideExit, type WithdrawalRecord } from "../../funding/requests/model";
import { withdrawalMilestones } from "./facts";
import { withdrawalTimelineFailure, type WithdrawalTimelineFailure } from "./failure";
import { withdrawalPhase } from "./phases";
import { WITHDRAWAL_TIMELINE } from "./spec";
import { waitingText, withdrawalText } from "./texts";

export interface WithdrawalTimeline {
  /** Absent while the payment is awaited and nothing ended. */
  readonly view?: TimelineView;
  /** Absent once the withdrawal ended, well or badly: the design's done frames carry no band. */
  readonly message?: TimelineMessage;
  readonly detail?: string;
  /** Present once the withdrawal ended short of success. */
  readonly failure?: WithdrawalTimelineFailure;
}

export interface WithdrawalTimelineOptions {
  readonly now: number;
  /** The view shown before, so that the current line never moves back. */
  readonly previous?: TimelineView;
}

/** When the withdrawal ended short of success, which stops the current line. */
function failedAt(record: WithdrawalRecord): number | undefined {
  const { status } = record;
  return isWithdrawalSideExit(record) && "at" in status ? status.at : undefined;
}

export function withdrawalTimeline(
  record: WithdrawalRecord,
  { now, previous }: WithdrawalTimelineOptions,
): WithdrawalTimeline {
  const view = timelineView(WITHDRAWAL_TIMELINE, {
    reached: withdrawalMilestones(record),
    phase: (index) => withdrawalPhase(record, index),
    failedAt: failedAt(record),
    now,
    previous,
  });
  if (view === undefined) return { message: normal(waitingText(record)) };
  if (view.state === "failed") return { view, failure: withdrawalTimelineFailure(record) };
  if (view.state === "done") return { view };
  const text = withdrawalText(record, view.phase, { delayed: view.state === "delayed", now });
  return {
    view,
    message: text.message,
    ...(text.detail === undefined ? {} : { detail: text.detail }),
  };
}
