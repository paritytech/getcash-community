import { describe, expect, it, vi } from "vitest";
import { LINE_LIMIT, timelineView } from "../app/funding/timeline/model";
import type {
  PhaseIndex,
  PhaseInput,
  PhasePart,
  ReachedMilestones,
  TimelineInput,
  TimelineView,
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

function currentLine(view: TimelineView | undefined): number {
  if (view === undefined || view.state === "done" || view.state === "failed") {
    throw new Error("The timeline has no current line");
  }
  return view.lines[view.phase]!;
}

describe("top-up timeline model", () => {
  it.each([
    ["a part at its start", [part()], 0, 0],
    ["time inside a part", [part()], T, AT_T],
    ["time approaching the end of a part", [part()], 100 * T, 1],
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
    ["a full fraction before the fact", [part({ completed: {} }), part({ fraction: 1 })], 0, 1],
    ["a skipped part", [part(), part({ completed: {} }), part()], 0, 2 / 3],
    [
      "all parts complete before the milestone",
      [part({ completed: {} }), part({ completed: {} })],
      0,
      1,
    ],
    ["weighted shares", [part({ completed: {} }), part({ weight: 2 })], 0, 1 / 3],
  ] satisfies [string, PhaseInput["parts"], number, number][])(
    "fills the current line up to its limit for %s",
    (_, parts, now, progress) => {
      expect(currentLine(evaluate({ parts }, { now }))).toBeCloseTo(LINE_LIMIT * progress, 10);
    },
  );

  it.each([
    ["a higher fill in the same phase", 1, 0.64, 0.64],
    ["a lower fill in the same phase", 1, 0.1, LINE_LIMIT * AT_T],
    ["a higher fill in an earlier phase", 0, 0.64, LINE_LIMIT * AT_T],
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

  it("fills a line past its limit only when its milestone is reached", () => {
    const parts: PhaseInput["parts"] = [part({ completed: { at: 0 } }), part()];
    const before = evaluate({ parts }, { now: 100 * T });
    const after = evaluate(
      { parts },
      {
        reached: { started: { at: 0 }, accepted: { at: 100 * T } },
        now: 100 * T,
        previous: before,
      },
    );

    expect(currentLine(before)).toBeLessThanOrEqual(LINE_LIMIT);
    expect(after?.lines[0]).toBe(1);
  });

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
      lines: [1, 1, expect.closeTo(LINE_LIMIT * AT_T, 10), 0, 0, 0],
    });
  });

  it.each([
    ["delayed", "the route reports a delay", { parts: [part()], delayed: true }, 0],
    ["active", "the part in progress runs far past its T", { parts: [part()] }, 100 * T],
  ] satisfies [string, string, PhaseInput, number][])("is %s when %s", (state, _, phase, now) => {
    expect(evaluate(phase, { now })?.state).toBe(state);
  });

  it.each([
    [
      "stops the current line and fails its end milestone",
      { started: { at: 0 }, accepted: { at: 0 } },
      {
        state: "failed",
        failed: 2,
        milestones: [
          "complete",
          "complete",
          "failed",
          "upcoming",
          "upcoming",
          "upcoming",
          "upcoming",
        ],
        lines: [1, expect.closeTo(LINE_LIMIT * AT_T, 10), 0, 0, 0, 0],
      },
    ],
    [
      "fails Started when no milestone was reached",
      {},
      {
        state: "failed",
        failed: 0,
        milestones: [
          "failed",
          "upcoming",
          "upcoming",
          "upcoming",
          "upcoming",
          "upcoming",
          "upcoming",
        ],
        lines: [0, 0, 0, 0, 0, 0],
      },
    ],
  ] satisfies [string, ReachedMilestones, TimelineView][])(
    "on a failure %s",
    (_, reached, view) => {
      expect(
        evaluate({ parts: [part()], delayed: true }, { reached, failedAt: T, now: 100 * T }),
      ).toEqual(view);
    },
  );

  it("has no view before Started unless the top-up failed", () => {
    expect(evaluate({ parts: [part()] }, { reached: {} })).toBeUndefined();
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
    ["a fraction that is not a number", part({ fraction: Number.NaN })],
  ])("rejects %s", (_, invalid) => {
    expect(() => evaluate({ parts: [invalid] })).toThrow(RangeError);
  });
});
