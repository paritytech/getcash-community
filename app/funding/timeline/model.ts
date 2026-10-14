import {
  MILESTONES,
  type MilestoneIndex,
  type MilestoneState,
  type PhaseIndex,
  type PhaseInput,
  type PhasePart,
  type TimelineInput,
  type TimelineView,
} from "./types";

const FILL_RATE = 3;
const PHASE_COUNT = MILESTONES.length - 1;

/** The most a line fills before its end milestone is reached. */
export const LINE_LIMIT = 0.65;

function isPositive(value: number): boolean {
  return value > 0 && Number.isFinite(value);
}

function assertValidPart(part: PhasePart): void {
  if (!isPositive(part.weight)) {
    throw new RangeError(`Phase part weight must be a positive number, got ${part.weight}`);
  }
  if (!isPositive(part.expectedMs)) {
    throw new RangeError(`Phase part expected time must be positive, got ${part.expectedMs}`);
  }
  if (part.fraction !== undefined && !Number.isFinite(part.fraction)) {
    throw new RangeError(`Phase part fraction must be a finite number, got ${part.fraction}`);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The fill of a line that has not reached its end milestone. */
function lineFill({ parts }: PhaseInput, phaseStartedAt: number | undefined, at: number): number {
  parts.forEach(assertValidPart);
  let lastCompleted = -1;
  parts.forEach((part, index) => {
    if (part.completed) lastCompleted = index;
  });
  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  const index = Math.min(lastCompleted + 1, parts.length - 1);
  const part = parts[index]!;
  const before = parts.slice(0, index).reduce((sum, { weight }) => sum + weight, 0) / totalWeight;
  const share = part.weight / totalWeight;
  if (part.completed) return LINE_LIMIT;

  const startedAt = part.startedAt ?? parts[lastCompleted]?.completed?.at ?? phaseStartedAt;
  const elapsed = startedAt === undefined ? 0 : Math.max(0, at - startedAt);
  const within = part.fraction ?? 1 - Math.exp((-FILL_RATE * elapsed) / part.expectedMs);
  return LINE_LIMIT * (before + share * clamp(within, 0, 1));
}

/** The index of the last milestone the view reached, -1 when Started failed. */
export function lastReached(view: TimelineView): number {
  if (view.state === "done") return PHASE_COUNT;
  return view.state === "failed" ? view.failed - 1 : view.phase;
}

/** Milestones up to `last` complete, the one after it failed when `failed`, the rest upcoming. */
const milestoneStates = (last: number, failed: boolean): MilestoneState[] =>
  MILESTONES.map((_, index) =>
    index <= last ? "complete" : index === last + 1 && failed ? "failed" : "upcoming",
  );

/** Lines before `phase` full, the line of `phase` at `fill`, the rest empty. */
const lineFills = (phase: number, fill: number): number[] =>
  Array.from({ length: PHASE_COUNT }, (_, index) =>
    index < phase ? 1 : index === phase ? fill : 0,
  );

/**
 * Evaluates the timeline: milestone states, the fill of each phase line and the overall state.
 * Absent while no milestone is reached, unless the top-up failed there: then Started fails.
 */
export function timelineView(input: TimelineInput): TimelineView | undefined {
  const { reached, failedAt } = input;
  const last = MILESTONES.reduce(
    (found, milestone, index) => (reached[milestone] ? index : found),
    -1,
  );
  if (last === PHASE_COUNT) {
    return { state: "done", milestones: milestoneStates(last, false), lines: lineFills(last, 1) };
  }
  const failed = failedAt !== undefined;
  if (last < 0) {
    return failed
      ? {
          state: "failed",
          failed: 0,
          milestones: milestoneStates(last, true),
          lines: lineFills(last, 0),
        }
      : undefined;
  }

  const phase = last as PhaseIndex;
  const phaseInput = input.phase(phase);
  const fill = lineFill(phaseInput, reached[MILESTONES[phase]]?.at, failedAt ?? input.now);
  const { previous } = input;
  const shown = previous && lastReached(previous) === phase ? (previous.lines[phase] ?? 0) : 0;
  const milestones = milestoneStates(phase, failed);
  const lines = lineFills(phase, Math.max(fill, shown));
  if (failed) return { state: "failed", failed: (phase + 1) as MilestoneIndex, milestones, lines };
  return { state: phaseInput.delayed ? "delayed" : "active", phase, milestones, lines };
}
