import { lastReached } from "../../../funding/timeline/model";
import type {
  LabelAlign,
  MilestoneSpec,
  MilestoneState,
  TimelineSpec,
  TimelineView,
} from "../../../funding/timeline/types";

export type { LabelAlign };

export type MilestoneSize = "large" | "small";

/** The colour of a line: green when complete, white, amber or red while it fills, grey after it. */
export type LineTone = "complete" | "current" | "delayed" | "failed" | "upcoming";

/** The colour of the ripple on the milestone the current line is heading to. */
export type HaloTone = "current" | "delayed";

export interface DrawnMilestone {
  readonly id: string;
  readonly size: MilestoneSize;
  /** Large milestones have their name, a failed one the spec's failed label; small ones none. */
  readonly label?: string;
  readonly labelAlign: LabelAlign;
  readonly state: MilestoneState;
  /** The large milestone the journey is heading to, or the failed one, for assistive technology. */
  readonly current: boolean;
  /** The ripple on the next milestone while the journey is in progress. */
  readonly halo: HaloTone | null;
}

export interface DrawnLine {
  /** The line's share of the width the lines stretch over. */
  readonly weight: number;
  /** From 0 to 1. */
  readonly fill: number;
  readonly tone: LineTone;
}

export interface TimelineDrawing {
  readonly milestones: readonly DrawnMilestone[];
  /** Line `i` runs from milestone `i` to milestone `i + 1`. */
  readonly lines: readonly DrawnLine[];
}

/** Only a journey in progress shows the halo. */
const HALO_TONES: Readonly<Partial<Record<TimelineView["state"], HaloTone>>> = {
  active: "current",
  delayed: "delayed",
};

/** The ring radius of each size, in px. The circle inside is 4 px (large) or 2 px (small) less. */
const RING_RADIUS: Readonly<Record<MilestoneSize, number>> = { large: 16, small: 8 };

const sizeOf = (milestone: MilestoneSpec): MilestoneSize =>
  milestone.label === undefined ? "small" : "large";

/** The name of a milestone drawn with `reached` milestones complete. */
function labelOf({ label, relabel }: MilestoneSpec, reached: number): string | undefined {
  return relabel !== undefined && reached >= relabel.from ? relabel.label : label;
}

const ringEdges = (spec: TimelineSpec) =>
  spec.milestones.map((milestone) => {
    const radius = RING_RADIUS[sizeOf(milestone)];
    return { start: milestone.centre - radius, end: milestone.centre + radius };
  });

/** The space before the first ring and after the last, in px. */
export function timelineInsets(spec: TimelineSpec): { start: number; end: number } {
  const edges = ringEdges(spec);
  return { start: edges[0]!.start, end: spec.designWidth - edges[edges.length - 1]!.end };
}

/** Each line's share of the stretched width: the designer's gap between the two rings. */
function lineWeights(spec: TimelineSpec): number[] {
  const edges = ringEdges(spec);
  return edges.slice(1).map((edge, index) => edge.start - edges[index]!.end);
}

/**
 * What to draw for a view on its spec. `shownReached` is the last milestone drawn as reached; it
 * trails `lastReached(view)` while several milestones complete one after the other, and the line
 * after it then fills to its end. A failure shows once the drawing reaches it, the halo once it
 * catches up.
 */
export function timelineDrawing(
  spec: TimelineSpec,
  view: TimelineView,
  shownReached: number = lastReached(view),
): TimelineDrawing {
  const { milestones } = spec;
  const last = lastReached(view);
  const reached = Math.min(shownReached, last);
  const failed = view.state === "failed" && reached === last ? view.failed : -1;
  const halo = reached === last ? (HALO_TONES[view.state] ?? null) : null;
  const heading =
    view.state === "done"
      ? -1
      : failed >= 0
        ? failed
        : milestones.findIndex(
            (milestone, index) => index > reached && sizeOf(milestone) === "large",
          );

  const lines = lineWeights(spec).map((weight, index): DrawnLine => {
    if (index < reached) return { weight, fill: 1, tone: "complete" };
    if (index > reached) return { weight, fill: 0, tone: "upcoming" };
    if (reached < last) return { weight, fill: 1, tone: "current" };
    const tone = failed >= 0 ? "failed" : view.state === "delayed" ? "delayed" : "current";
    return { weight, fill: view.lines[index] ?? 0, tone };
  });

  return {
    milestones: milestones.map((milestone, index) => {
      const isFailed = index === failed;
      const label = isFailed ? spec.failedLabel : labelOf(milestone, reached);
      return {
        id: milestone.id,
        size: isFailed ? "large" : sizeOf(milestone),
        ...(label === undefined ? {} : { label }),
        labelAlign: isFailed ? (milestone.failedLabelAlign ?? "centre") : "centre",
        state: index <= reached ? "complete" : isFailed ? "failed" : "upcoming",
        current: index === heading,
        halo: index === reached + 1 ? halo : null,
      };
    }),
    lines,
  };
}
