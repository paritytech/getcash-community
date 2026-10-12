// A top-up's row on the list: the ring's fill from its timeline and a short headline.

import type { FundingRoute } from "../selection";
import type { FundingTopUpProgress } from "../top-ups";
import { lastReached } from "./model";
import type { TopUpTimeline } from "./top-up";
import type { TimelineView } from "./types";

/** How far the whole top-up has come, from 0 to 1: the completed lines and the current line's
 *  fill, over all the lines. */
export function overallProgress(view: TimelineView): number {
  return view.lines.reduce((sum, fill) => sum + fill, 0) / view.lines.length;
}

export interface ListHeadline {
  readonly text: string;
  /** Drawn amber. */
  readonly delayed: boolean;
}

const WAITING: Readonly<Record<FundingRoute, string>> = {
  crypto: "Waiting for your deposit",
  card: "Waiting for your payment",
  bank: "Waiting for your bank transfer",
};

/** The last phase the provider owns on the list; the phases after it are the Polkadot part. */
const LAST_PROVIDER_PHASE = 2;

/** The list row's short status line: what is being waited for until the timeline opens, then the
 *  part of the timeline the top-up is in. The journey's timeline carries the detail. */
export function listHeadline(route: FundingRoute, timeline?: TopUpTimeline): ListHeadline {
  if (timeline === undefined) return { text: WAITING[route], delayed: false };
  const { view } = timeline;
  const delayed = view.state === "delayed";
  if (lastReached(view) > LAST_PROVIDER_PHASE) return { text: "Adding to your balance", delayed };
  // A fiat provider that is late or retrying may still take the money: never invite a second one.
  if (delayed && route !== "crypto") return { text: "Delayed, don't pay again", delayed };
  return { text: "On its way", delayed };
}

/** A running row's ring: the overall progress once the timeline opened. */
export function listProgress(timeline?: TopUpTimeline): FundingTopUpProgress {
  if (timeline === undefined) return { value: 0, tone: "waiting", delayed: false };
  const delayed = timeline.view.state === "delayed";
  return { value: overallProgress(timeline.view), tone: delayed ? "delayed" : "active", delayed };
}
