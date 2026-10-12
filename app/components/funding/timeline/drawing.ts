import type { FundingRoute } from "../../../funding/selection";
import type { TopUpTimeline } from "../../../funding/timeline/top-up";
import { lastReached } from "../../../funding/timeline/model";
import {
  MILESTONES,
  type Milestone,
  type MilestoneState,
  type TimelineView,
} from "../../../funding/timeline/types";

export type MilestoneSize = "large" | "small";

/** Where a label sits under its milestone: centred on it, starting at its centre and extending
 *  right (`start`), or ending at its centre and extending left (`end`). */
export type LabelAlign = "start" | "centre" | "end";

/** The colour of a line: green when complete, white, amber or red while it fills, grey after it. */
export type LineTone = "complete" | "current" | "delayed" | "failed" | "upcoming";

export interface DrawnMilestone {
  readonly id: Milestone;
  readonly size: MilestoneSize;
  /** Large milestones have their name, a failed one `Failed`; small ones have none. */
  readonly label?: string;
  readonly labelAlign: LabelAlign;
  readonly state: MilestoneState;
  /** The large milestone the top-up is heading to, or the failed one, for assistive technology. */
  readonly current: boolean;
}

export interface DrawnLine {
  /** The line's share of the width the lines stretch over. */
  readonly weight: number;
  /** From 0 to 1. */
  readonly fill: number;
  readonly tone: LineTone;
  /** The phase is live: the head of the fill shows the soft light. */
  readonly live: boolean;
}

export interface TimelineDrawing {
  readonly milestones: readonly DrawnMilestone[];
  /** Line `i` runs from milestone `i` to milestone `i + 1`. */
  readonly lines: readonly DrawnLine[];
}

const LABELS: Partial<Record<Milestone, string>> = {
  started: "Started",
  received: "Received",
  added: "Added",
};
const FAILED_LABEL = "Failed";

/** A small milestone grown on failure leans its label away from its nearer labelled neighbour,
 *  toward the longer line beside it. */
const FAILED_LABEL_ALIGN: Readonly<Partial<Record<Milestone, LabelAlign>>> = {
  accepted: "start",
  sent: "end",
  converted: "start",
  moved: "end",
};

/** The ring radius of each size, in px. The circle inside is 4 px (large) or 2 px (small) less. */
const RING_RADIUS: Readonly<Record<MilestoneSize, number>> = { large: 16, small: 8 };

const sizeOf = (milestone: Milestone): MilestoneSize =>
  LABELS[milestone] === undefined ? "small" : "large";

/** The designer's milestone centres on a 370 px card. */
const DESIGN_WIDTH = 370;
const DESIGN_CENTRES = [34.5, 77, 141, 187.5, 234, 298, 338] as const;

const ringEdges = MILESTONES.map((milestone, index) => {
  const radius = RING_RADIUS[sizeOf(milestone)];
  const centre = DESIGN_CENTRES[index]!;
  return { start: centre - radius, end: centre + radius };
});

/** The space before the first ring and after the last, in px. */
export const TIMELINE_INSETS = {
  start: ringEdges[0]!.start,
  end: DESIGN_WIDTH - ringEdges[ringEdges.length - 1]!.end,
} as const;

/** Each line's share of the stretched width: the designer's gap between the two rings. */
const LINE_WEIGHTS = ringEdges.slice(1).map((edge, index) => edge.start - ringEdges[index]!.end);

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

/**
 * What to draw for a view. `shownReached` is the last milestone drawn as reached; it trails
 * `lastReached(view)` while several milestones complete one after the other, and the line after it
 * then fills to its end. A failure shows once the drawing reaches it.
 */
export function timelineDrawing(
  view: TimelineView,
  shownReached: number = lastReached(view),
): TimelineDrawing {
  const last = lastReached(view);
  const reached = Math.min(shownReached, last);
  const failed = view.state === "failed" && reached === last ? view.failed : -1;
  const live = view.state === "active" || view.state === "delayed";
  const heading =
    view.state === "done"
      ? -1
      : failed >= 0
        ? failed
        : MILESTONES.findIndex(
            (milestone, index) => index > reached && sizeOf(milestone) === "large",
          );

  const lines = LINE_WEIGHTS.map((weight, index): DrawnLine => {
    if (index < reached) return { weight, fill: 1, tone: "complete", live: false };
    if (index > reached) return { weight, fill: 0, tone: "upcoming", live: false };
    if (reached < last) return { weight, fill: 1, tone: "current", live };
    const tone = failed >= 0 ? "failed" : view.state === "delayed" ? "delayed" : "current";
    return { weight, fill: view.lines[index] ?? 0, tone, live };
  });

  return {
    milestones: MILESTONES.map((id, index) => {
      const isFailed = index === failed;
      const label = isFailed ? FAILED_LABEL : LABELS[id];
      return {
        id,
        size: isFailed ? "large" : sizeOf(id),
        ...(label === undefined ? {} : { label }),
        labelAlign: isFailed ? (FAILED_LABEL_ALIGN[id] ?? "centre") : "centre",
        state: index <= reached ? "complete" : isFailed ? "failed" : "upcoming",
        current: index === heading,
      };
    }),
    lines,
  };
}
