import { describe, expect, it } from "vitest";
import {
  listHeadline,
  overallProgress,
  TIMELINE_INSETS,
  timelineDrawing,
  type TimelineDrawing,
} from "../app/components/funding/timeline/drawing";
import { timelineView } from "../app/funding/timeline/model";
import { MILESTONES, type PhaseIndex, type TimelineView } from "../app/funding/timeline/types";

function current(
  state: "active" | "delayed" | "failed",
  phase: PhaseIndex,
  fill: number,
): TimelineView {
  return {
    state,
    phase,
    milestones: MILESTONES.map((_, index) => (index <= phase ? "complete" : "upcoming")),
    lines: MILESTONES.slice(1).map((_, index) => (index < phase ? 1 : index === phase ? fill : 0)),
  };
}

const done: TimelineView = {
  state: "done",
  milestones: MILESTONES.map(() => "complete"),
  lines: MILESTONES.slice(1).map(() => 1),
};

/** Received reached with Accepted and Sent never seen. */
const skipped = timelineView({
  reached: { started: { at: 0 }, received: { at: 0 } },
  phase: () => ({ parts: [{ weight: 1, expectedMs: 1_000 }] }),
  now: 0,
});

/** Milestones as `●` (complete) and `○`, the milestone marked current, and each line. */
function summary({ milestones, lines }: TimelineDrawing) {
  return {
    milestones: milestones.map(({ complete }) => (complete ? "●" : "○")).join(""),
    current: milestones.find((milestone) => milestone.current)?.id ?? null,
    lines: lines.map(({ tone, fill, live }) => `${tone} ${fill}${live ? " live" : ""}`),
  };
}

describe("top-up timeline drawing", () => {
  it.each([
    [
      "an active first phase",
      current("active", 0, 0.4),
      undefined,
      "●○○○○○○",
      "received",
      ["current 0.4 live", "upcoming 0", "upcoming 0", "upcoming 0", "upcoming 0", "upcoming 0"],
    ],
    [
      "a delayed phase",
      current("delayed", 3, 0.25),
      undefined,
      "●●●●○○○",
      "added",
      ["complete 1", "complete 1", "complete 1", "delayed 0.25 live", "upcoming 0", "upcoming 0"],
    ],
    [
      "a skipped milestone",
      skipped,
      undefined,
      "●●●●○○○",
      "added",
      ["complete 1", "complete 1", "complete 1", "current 0 live", "upcoming 0", "upcoming 0"],
    ],
    [
      "a skipped milestone still completing",
      skipped,
      1,
      "●●○○○○○",
      "received",
      ["complete 1", "current 1 live", "upcoming 0", "upcoming 0", "upcoming 0", "upcoming 0"],
    ],
    [
      "a failed phase",
      current("failed", 2, 0.6),
      undefined,
      "●●●○○○○",
      "received",
      ["complete 1", "complete 1", "current 0.6", "upcoming 0", "upcoming 0", "upcoming 0"],
    ],
    [
      "a done top-up",
      done,
      undefined,
      "●●●●●●●",
      null,
      ["complete 1", "complete 1", "complete 1", "complete 1", "complete 1", "complete 1"],
    ],
  ])("draws %s", (_, view, shownReached, milestones, heading, lines) => {
    expect(summary(timelineDrawing(view, shownReached))).toEqual({
      milestones,
      current: heading,
      lines,
    });
  });

  it("keeps the designer's spacing between the rings", () => {
    const { lines } = timelineDrawing(done);
    expect(lines.map(({ weight }) => weight)).toEqual([18.5, 48, 22.5, 22.5, 48, 16]);
    expect(TIMELINE_INSETS).toEqual({ start: 18.5, end: 16 });
  });
});

describe("top-up overall progress", () => {
  it.each([
    ["the first line filling", current("active", 0, 0.6), 0.6 / 6],
    ["a delayed fourth line", current("delayed", 3, 0.3), 3.3 / 6],
    ["a failed line", current("failed", 2, 0.6), 2.6 / 6],
    ["a done top-up", done, 1],
  ])("counts %s", (_, view, expected) => {
    expect(overallProgress(view)).toBeCloseTo(expected);
  });
});

describe("top-up list headline", () => {
  it.each([
    ["crypto before the timeline", "crypto", undefined, "Waiting for your deposit", false],
    ["card before the timeline", "card", undefined, "Waiting for your payment", false],
    ["bank before the timeline", "bank", undefined, "Waiting for your bank transfer", false],
    ["the provider part", "card", current("active", 2, 0.5), "On its way", false],
    ["the Polkadot part", "crypto", current("active", 3, 0.5), "Adding to your balance", false],
    ["a delayed card", "card", current("delayed", 0, 0.5), "Delayed, don't pay again", true],
    ["a delayed bank", "bank", current("delayed", 1, 0.5), "Delayed, don't pay again", true],
    ["a delayed Chainflip provider part", "crypto", current("delayed", 1, 0.5), "On its way", true],
    ["a delayed Polkadot part", "card", current("delayed", 4, 0.5), "Adding to your balance", true],
  ] as const)("words %s", (_, route, view, text, delayed) => {
    expect(listHeadline(route, view && { view })).toEqual({ text, delayed });
  });
});
