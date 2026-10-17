import type {
  MilestoneState,
  PhaseInput,
  PhasePart,
  TimelineInput,
  TimelineSpec,
  TimelineView,
} from "./types";

const FILL_RATE = 3;

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

/** The index of the last milestone the view reached, -1 when the first milestone failed. */
export function lastReached(view: TimelineView): number {
  if (view.state === "done") return view.lines.length;
  return view.state === "failed" ? view.failed - 1 : view.phase;
}

/** Milestones up to `last` complete, the one after it failed when `failed`, the rest upcoming. */
const milestoneStates = (count: number, last: number, failed: boolean): MilestoneState[] =>
  Array.from({ length: count }, (_, index) =>
    index <= last ? "complete" : index === last + 1 && failed ? "failed" : "upcoming",
  );

/** Lines before `phase` full, the line of `phase` at `fill`, the rest empty. */
const lineFills = (count: number, phase: number, fill: number): number[] =>
  Array.from({ length: count }, (_, index) => (index < phase ? 1 : index === phase ? fill : 0));

/**
 * Evaluates a timeline on its spec: milestone states, the fill of each phase line and the overall
 * state. Absent while no milestone is reached, unless the journey failed there: then the first
 * milestone fails.
 */
export function timelineView<Id extends string>(
  spec: TimelineSpec<Id>,
  input: TimelineInput<Id>,
): TimelineView | undefined {
  const { reached, failedAt } = input;
  const { milestones } = spec;
  const phaseCount = milestones.length - 1;
  const last = milestones.reduce((found, { id }, index) => (reached[id] ? index : found), -1);
  if (last === phaseCount) {
    return {
      state: "done",
      milestones: milestoneStates(milestones.length, last, false),
      lines: lineFills(phaseCount, last, 1),
    };
  }
  const failed = failedAt !== undefined;
  if (last < 0) {
    return failed
      ? {
          state: "failed",
          failed: 0,
          milestones: milestoneStates(milestones.length, last, true),
          lines: lineFills(phaseCount, last, 0),
        }
      : undefined;
  }

  const phase = last;
  const phaseInput = input.phase(phase);
  const fill = lineFill(phaseInput, reached[milestones[phase]!.id]?.at, failedAt ?? input.now);
  // The view shown before is this timeline's own: each keeps its own memo, and specs of equal
  // length are told apart by nothing else. A view of another length is plainly another spec's.
  const { previous } = input;
  const comparable = previous !== undefined && previous.lines.length === phaseCount;
  const shown = comparable && lastReached(previous) === phase ? (previous.lines[phase] ?? 0) : 0;
  const states = milestoneStates(milestones.length, phase, failed);
  const lines = lineFills(phaseCount, phase, Math.max(fill, shown));
  if (failed) return { state: "failed", failed: phase + 1, milestones: states, lines };
  return { state: phaseInput.delayed ? "delayed" : "active", phase, milestones: states, lines };
}
