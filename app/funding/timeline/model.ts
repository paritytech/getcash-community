import {
  MILESTONES,
  type MilestoneState,
  type PhaseIndex,
  type PhaseInput,
  type PhasePart,
  type TimelineInput,
  type TimelineView,
} from "./types";

const FILL_RATE = 3;
const PHASE_COUNT = MILESTONES.length - 1;

/** The most of its share a part fills before its fact arrives. */
export const PART_LIMIT = 0.985;

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
  if (part.completed) return before + share * PART_LIMIT;

  const startedAt = part.startedAt ?? parts[lastCompleted]?.completed?.at ?? phaseStartedAt;
  const elapsed = startedAt === undefined ? 0 : Math.max(0, at - startedAt);
  const within = part.fraction ?? 1 - Math.exp((-FILL_RATE * elapsed) / part.expectedMs);
  return before + share * clamp(within, 0, PART_LIMIT);
}

/** Evaluates the timeline: milestone states, the fill of each phase line and the overall state. */
export function timelineView(input: TimelineInput): TimelineView {
  const { reached } = input;
  const lastReached = MILESTONES.reduce(
    (last, milestone, index) => (reached[milestone] ? index : last),
    0,
  );
  if (lastReached === PHASE_COUNT) {
    return {
      state: "done",
      milestones: MILESTONES.map((): MilestoneState => "complete"),
      lines: Array.from({ length: PHASE_COUNT }, () => 1),
    };
  }

  const phase = lastReached as PhaseIndex;
  const failed = input.failedAt !== undefined;
  const phaseInput = input.phase(phase);
  const fill = lineFill(phaseInput, reached[MILESTONES[phase]]?.at, input.failedAt ?? input.now);
  const { previous } = input;
  const shown =
    previous && previous.state !== "done" && previous.phase === phase
      ? (previous.lines[phase] ?? 0)
      : 0;
  const line = Math.max(fill, shown);

  return {
    state: failed ? "failed" : phaseInput.delayed ? "delayed" : "active",
    phase,
    milestones: MILESTONES.map((_, index): MilestoneState =>
      index <= phase ? "complete" : index === phase + 1 && failed ? "failed" : "upcoming",
    ),
    lines: Array.from({ length: PHASE_COUNT }, (_, index) =>
      index < phase ? 1 : index === phase ? line : 0,
    ),
  };
}
