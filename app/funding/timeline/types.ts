export const MILESTONES = [
  "started",
  "accepted",
  "sent",
  "received",
  "converted",
  "moved",
  "added",
] as const;

export type Milestone = (typeof MILESTONES)[number];

/** The position of a milestone in `MILESTONES`. */
export type MilestoneIndex = PhaseIndex | 6;

/** Phase `i` is the line from `MILESTONES[i]` to `MILESTONES[i + 1]`. */
export type PhaseIndex = 0 | 1 | 2 | 3 | 4 | 5;

/** A fact that arrived, with the time it was first seen when known. Times are milliseconds. */
export interface Fact {
  readonly at?: number;
}

/** The milestones whose fact arrived. A reached milestone implies every milestone before it. */
export type ReachedMilestones = Readonly<Partial<Record<Milestone, Fact>>>;

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

export interface TimelineInput {
  readonly reached: ReachedMilestones;
  /** The parts of a phase. Called for the current phase only. */
  readonly phase: (index: PhaseIndex) => PhaseInput;
  /** When the top-up failed. The current line stops at the fill it had then; with no milestone
   *  reached, Started fails. */
  readonly failedAt?: number;
  readonly now: number;
  /** The view shown before, so that the current line never moves back. */
  readonly previous?: TimelineView;
}

export type MilestoneState = "complete" | "upcoming" | "failed";

interface TimelineLines {
  /** One state per milestone, in the order of `MILESTONES`. */
  readonly milestones: readonly MilestoneState[];
  /** The fill of each phase line, from 0 to 1, by phase index. */
  readonly lines: readonly number[];
}

export type TimelineView =
  | (TimelineLines & { readonly state: "active" | "delayed"; readonly phase: PhaseIndex })
  | (TimelineLines & {
      readonly state: "failed";
      /** The red milestone: the end of the line that stopped, or Started before it was reached. */
      readonly failed: MilestoneIndex;
    })
  | (TimelineLines & { readonly state: "done" });
