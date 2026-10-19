/** Where a label sits under its milestone: centred on it, starting at its centre and extending
 *  right (`start`), or ending at its centre and extending left (`end`). */
export type LabelAlign = "start" | "centre" | "end";

/** One milestone of a timeline, as the designer placed it. A labelled milestone is drawn large. */
export interface MilestoneSpec<Id extends string = string> {
  readonly id: Id;
  /** Large milestones have a name; small ones have none. */
  readonly label?: string;
  /** The name once milestone `from` is drawn as reached, when the design renames it then. */
  readonly relabel?: { readonly from: number; readonly label: string };
  /** The designer's centre on the spec's design width, in px. */
  readonly centre: number;
  /** Where a small milestone grown on failure leans its label; centred when absent. */
  readonly failedLabelAlign?: LabelAlign;
}

/** A timeline: its milestones in order, on the designer's card. Phase `i` is the line from
 *  milestone `i` to milestone `i + 1`. */
export interface TimelineSpec<Id extends string = string> {
  readonly milestones: readonly [MilestoneSpec<Id>, MilestoneSpec<Id>, ...MilestoneSpec<Id>[]];
  /** The width of the designer's card, in px. */
  readonly designWidth: number;
  /** The accessible name of the timeline. */
  readonly ariaLabel: string;
  /** The label of a failed milestone. */
  readonly failedLabel: string;
}

export const MILESTONES = [
  "started",
  "accepted",
  "sent",
  "received",
  "converted",
  "moved",
  "added",
] as const;

/** The top-up's milestones. */
export type Milestone = (typeof MILESTONES)[number];

/** The position of a top-up milestone in `MILESTONES`. */
export type MilestoneIndex = PhaseIndex | 6;

/** A top-up phase: `i` is the line from `MILESTONES[i]` to `MILESTONES[i + 1]`. */
export type PhaseIndex = 0 | 1 | 2 | 3 | 4 | 5;

/** A fact that arrived, with the time it was first seen when known. Times are milliseconds. */
export interface Fact {
  readonly at?: number;
}

/** The milestones whose fact arrived. A reached milestone implies every milestone before it. */
export type ReachedMilestones<Id extends string = Milestone> = Readonly<Partial<Record<Id, Fact>>>;

export interface PhasePart {
  /** The part's share of the line is its weight over the total weight of the phase. */
  readonly weight: number;
  /** The expected time `T` of the part. */
  readonly expectedMs: number;
  /** When the part began. Defaults to the completion of the last completed part, else the start
   *  of the phase. */
  readonly startedAt?: number;
  /** Real progress inside the part, from 0 to 1. Time moves the part when it is absent. */
  readonly fraction?: number;
  readonly completed?: Fact;
}

export interface PhaseInput {
  readonly parts: readonly [PhasePart, ...PhasePart[]];
  /** The route has evidence that the phase is slow, for example a provider error or a stalled
   *  block. Time since the phase began is never evidence. */
  readonly delayed?: boolean;
}

export interface TimelineInput<Id extends string = Milestone> {
  readonly reached: ReachedMilestones<Id>;
  /** The parts of a phase. Called for the current phase only. */
  readonly phase: (index: number) => PhaseInput;
  /** When the journey failed. The current line stops at the fill it had then; with no milestone
   *  reached, the first milestone fails. */
  readonly failedAt?: number;
  readonly now: number;
  /** The view shown before, so that the current line never moves back. */
  readonly previous?: TimelineView;
}

export type MilestoneState = "complete" | "upcoming" | "failed";

interface TimelineLines {
  /** One state per milestone, in the order of the spec. */
  readonly milestones: readonly MilestoneState[];
  /** The fill of each phase line, from 0 to 1, by phase index. */
  readonly lines: readonly number[];
}

/** The evaluated timeline. `phase` and `failed` index the spec the view was evaluated with. */
export type TimelineView =
  | (TimelineLines & { readonly state: "active" | "delayed"; readonly phase: number })
  | (TimelineLines & {
      readonly state: "failed";
      /** The red milestone: the end of the line that stopped, or the first milestone before it
       *  was reached. */
      readonly failed: number;
    })
  | (TimelineLines & { readonly state: "done" });
