// A withdrawal's row on the list: the ring's fill from its timeline.

import type { WithdrawalRecord } from "../../funding/requests/model";
import { listProgress, overallProgress } from "../../funding/timeline/list";
import type { FundingTopUpProgress } from "../../funding/top-ups";
import type { WithdrawalTimeline } from "./withdrawal";

/** A row's ring: waiting until the timeline opens, full once sent, red where it stopped, else the
 *  overall progress. */
export function withdrawalListProgress(
  timeline: WithdrawalTimeline,
  record: WithdrawalRecord,
): FundingTopUpProgress {
  const { view } = timeline;
  if (view === undefined) return { value: 0, tone: "waiting", delayed: false };
  if (record.status.kind === "sent") return { value: 1, tone: "settled", delayed: false };
  if (view.state === "failed") {
    return { value: overallProgress(view), tone: "failed", delayed: false };
  }
  return listProgress({ view });
}
