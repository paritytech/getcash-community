import { describe, expect, it, vi } from "vitest";
import { PART_LIMIT, timelineView } from "../app/funding/timeline/model";
import type {
  PhaseIndex,
  PhaseInput,
  PhasePart,
  TimelineInput,
} from "../app/funding/timeline/types";

const T = 10_000;
const AT_T = 1 - Math.exp(-3);

function part(overrides: Partial<PhasePart> = {}): PhasePart {
  return { weight: 1, expectedMs: T, ...overrides };
}

function evaluate(phase: PhaseInput, overrides: Partial<TimelineInput> = {}) {
  return timelineView({
    reached: { started: { at: 0 } },
    phase: () => phase,
    now: 0,
    ...overrides,
  });
}

function currentLine(view: ReturnType<typeof timelineView>): number {
  if (view.state === "done") throw new Error("The timeline is done");
  return view.lines[view.phase]!;
}

describe("top-up timeline model", () => {
  it.each([
    ["a part at its start", [part()], 0, 0],
    ["time inside a part", [part()], T, AT_T],
    ["time approaching the end of a part", [part()], 100 * T, PART_LIMIT],
    ["a completed part", [part({ completed: { at: 4_000 } }), part()], 4_000, 0.5],
    [
      "time from the last completion",
      [part({ completed: { at: 4_000 } }), part()],
      4_000 + T,
      0.5 + 0.5 * AT_T,
    ],
    [
      "time from the part's own start",
      [part({ completed: { at: 4_000 } }), part({ startedAt: 6_000 })],
      6_000 + T,
      0.5 + 0.5 * AT_T,
    ],
    ["a real fraction", [part({ completed: {} }), part({ fraction: 0.5 })], 100 * T, 0.75],
    [
      "a full fraction before the fact",
      [part({ completed: {} }), part({ fraction: 1 })],
      0,
      0.5 + 0.5 * PART_LIMIT,
    ],
    ["a skipped part", [part(), part({ completed: {} }), part()], 0, 2 / 3],
    [
      "all parts complete before the milestone",
      [part({ completed: {} }), part({ completed: {} })],
      0,
      0.5 + 0.5 * PART_LIMIT,
    ],
    ["weighted shares", [part({ completed: {} }), part({ weight: 2 })], 0, 1 / 3],
  ] satisfies [string, PhaseInput["parts"], number, number][])(
    "fills the current line for %s",
    (_, parts, now, fill) => {
      expect(currentLine(evaluate({ parts }, { now }))).toBeCloseTo(fill, 10);
    },
  );

  it.each([
    ["a higher fill in the same phase", 1, 0.97, 0.97],
    ["a lower fill in the same phase", 1, 0.1, AT_T],
    ["a higher fill in an earlier phase", 0, 0.97, AT_T],
  ] satisfies [string, PhaseIndex, number, number][])(
    "keeps the line monotonic against %s shown before",
    (_, phase, shown, fill) => {
      const view = evaluate(
        { parts: [part()] },
        {
          reached: { started: { at: 0 }, accepted: { at: 0 } },
          now: T,
          previous: { state: "active", phase, milestones: [], lines: Array(6).fill(shown) },
        },
      );
      expect(currentLine(view)).toBeCloseTo(fill, 10);
    },
  );

  it("makes every milestone before a reached one complete", () => {
    const phase = vi.fn(() => ({ parts: [part()] }) satisfies PhaseInput);
    const view = timelineView({
      reached: { started: { at: 0 }, sent: { at: 5_000 } },
      phase,
      now: 5_000 + T,
    });

    expect(phase).toHaveBeenCalledWith(2);
    expect(view).toEqual({
      state: "active",
      phase: 2,
      milestones: [
        "complete",
        "complete",
        "complete",
        "upcoming",
        "upcoming",
        "upcoming",
        "upcoming",
      ],
      lines: [1, 1, expect.closeTo(AT_T, 10), 0, 0, 0],
    });
  });

  it.each([
    ["delayed", "the route reports a delay", { parts: [part()], delayed: true }, 0],
    ["delayed", "the part in progress runs past its T", { parts: [part()] }, T + 1],
    ["active", "the part in progress is at its T", { parts: [part()] }, T],
    [
      "active",
      "the part in progress is past its T but within its late time",
      { parts: [part({ lateAfterMs: 2 * T })] },
      T + 1,
    ],
    [
      "active",
      "the part in progress is never late",
      { parts: [part({ lateAfterMs: null })] },
      100 * T,
    ],
    [
      "active",
      "a part completed and the next one started",
      { parts: [part({ completed: { at: T } }), part()] },
      T + 1,
    ],
  ] satisfies [string, string, PhaseInput, number][])("is %s when %s", (state, _, phase, now) => {
    expect(evaluate(phase, { now }).state).toBe(state);
  });

  it("stops the current line at the failure and keeps later milestones grey", () => {
    const view = evaluate(
      { parts: [part()], delayed: true },
      { reached: { started: { at: 0 }, accepted: { at: 0 } }, failedAt: T, now: 100 * T },
    );

    expect(view).toEqual({
      state: "failed",
      phase: 1,
      milestones: [
        "complete",
        "complete",
        "failed",
        "upcoming",
        "upcoming",
        "upcoming",
        "upcoming",
      ],
      lines: [1, expect.closeTo(AT_T, 10), 0, 0, 0, 0],
    });
  });

  it("is done when every milestone is reached", () => {
    const phase = vi.fn(() => ({ parts: [part()] }) satisfies PhaseInput);
    const view = timelineView({
      reached: { started: {}, added: { at: 0 } },
      phase,
      failedAt: 0,
      now: 0,
    });

    expect(phase).not.toHaveBeenCalled();
    expect(view).toEqual({
      state: "done",
      milestones: Array(7).fill("complete"),
      lines: Array(6).fill(1),
    });
  });

  it.each([
    ["a zero weight", part({ weight: 0 })],
    ["a zero expected time", part({ expectedMs: 0 })],
    ["a zero late time", part({ lateAfterMs: 0 })],
    ["a fraction that is not a number", part({ fraction: Number.NaN })],
  ])("rejects %s", (_, invalid) => {
    expect(() => evaluate({ parts: [invalid] })).toThrow(RangeError);
  });
});
