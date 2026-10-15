import { describe, expect, it } from "vitest";
import {
  timelineInsets,
  timelineDrawing,
  type LabelAlign,
  type TimelineDrawing,
} from "../app/components/funding/timeline/drawing";
import { listHeadline, listProgress, overallProgress } from "../app/funding/timeline/list";
import { timelineView } from "../app/funding/timeline/model";
import { TOP_UP_TIMELINE } from "../app/funding/timeline/top-up-spec";
import {
  MILESTONES,
  type MilestoneIndex,
  type PhaseIndex,
  type TimelineSpec,
  type TimelineView,
} from "../app/funding/timeline/types";

function current(state: "active" | "delayed", phase: PhaseIndex, fill: number): TimelineView {
  return {
    state,
    phase,
    milestones: MILESTONES.map((_, index) => (index <= phase ? "complete" : "upcoming")),
    lines: MILESTONES.slice(1).map((_, index) => (index < phase ? 1 : index === phase ? fill : 0)),
  };
}

/** Milestone `failed` red, the line into it stopped at `fill`. */
function failedAt(failed: MilestoneIndex, fill: number): TimelineView {
  return {
    state: "failed",
    failed,
    milestones: MILESTONES.map((_, index) =>
      index < failed ? "complete" : index === failed ? "failed" : "upcoming",
    ),
    lines: MILESTONES.slice(1).map((_, index) =>
      index < failed - 1 ? 1 : index === failed - 1 ? fill : 0,
    ),
  };
}

const done: TimelineView = {
  state: "done",
  milestones: MILESTONES.map(() => "complete"),
  lines: MILESTONES.slice(1).map(() => 1),
};

/** Received reached with Accepted and Sent never seen. */
const skipped = timelineView(TOP_UP_TIMELINE, {
  reached: { started: { at: 0 }, received: { at: 0 } },
  phase: () => ({ parts: [{ weight: 1, expectedMs: 1_000 }] }),
  now: 0,
})!;

const MARKS = { complete: "●", upcoming: "○", failed: "✕" } as const;

/** Milestones as `●` (complete), `○` and `✕` (failed), the milestone marked current, the halo
 *  and each line. */
function summary({ milestones, lines }: TimelineDrawing) {
  const halo = milestones.find((milestone) => milestone.halo);
  return {
    milestones: milestones.map(({ state }) => MARKS[state]).join(""),
    current: milestones.find((milestone) => milestone.current)?.id ?? null,
    halo: halo ? `${halo.id} ${halo.halo}` : null,
    lines: lines.map(({ tone, fill }) => `${tone} ${fill}`),
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
      "accepted current",
      ["current 0.4", "upcoming 0", "upcoming 0", "upcoming 0", "upcoming 0", "upcoming 0"],
    ],
    [
      "an active phase heading to a station",
      current("active", 2, 0.5),
      undefined,
      "●●●○○○○",
      "received",
      "received current",
      ["complete 1", "complete 1", "current 0.5", "upcoming 0", "upcoming 0", "upcoming 0"],
    ],
    [
      "a delayed phase",
      current("delayed", 3, 0.25),
      undefined,
      "●●●●○○○",
      "added",
      "converted delayed",
      ["complete 1", "complete 1", "complete 1", "delayed 0.25", "upcoming 0", "upcoming 0"],
    ],
    [
      "a skipped milestone",
      skipped,
      undefined,
      "●●●●○○○",
      "added",
      "converted current",
      ["complete 1", "complete 1", "complete 1", "current 0", "upcoming 0", "upcoming 0"],
    ],
    [
      "a skipped milestone still completing",
      skipped,
      1,
      "●●○○○○○",
      "received",
      null,
      ["complete 1", "current 1", "upcoming 0", "upcoming 0", "upcoming 0", "upcoming 0"],
    ],
    [
      "a failure the drawing has not reached yet",
      failedAt(4, 0.3),
      1,
      "●●○○○○○",
      "received",
      null,
      ["complete 1", "current 1", "upcoming 0", "upcoming 0", "upcoming 0", "upcoming 0"],
    ],
    [
      "a done top-up",
      done,
      undefined,
      "●●●●●●●",
      null,
      null,
      ["complete 1", "complete 1", "complete 1", "complete 1", "complete 1", "complete 1"],
    ],
  ])("draws %s", (_, view, shownReached, milestones, heading, halo, lines) => {
    expect(summary(timelineDrawing(TOP_UP_TIMELINE, view, shownReached))).toEqual({
      milestones,
      current: heading,
      halo,
      lines,
    });
  });

  it.each([
    [
      "Started",
      failedAt(0, 0),
      "✕○○○○○○",
      ["upcoming 0", "upcoming 0", "upcoming 0", "upcoming 0", "upcoming 0", "upcoming 0"],
      "centre",
    ],
    [
      "Sent, grown, its label leaning away from Received",
      failedAt(2, 0.4),
      "●●✕○○○○",
      ["complete 1", "failed 0.4", "upcoming 0", "upcoming 0", "upcoming 0", "upcoming 0"],
      "end",
    ],
    [
      "Received",
      failedAt(3, 0.7),
      "●●●✕○○○",
      ["complete 1", "complete 1", "failed 0.7", "upcoming 0", "upcoming 0", "upcoming 0"],
      "centre",
    ],
    [
      "Converted, grown, its label leaning away from Received",
      failedAt(4, 0.5),
      "●●●●✕○○",
      ["complete 1", "complete 1", "complete 1", "failed 0.5", "upcoming 0", "upcoming 0"],
      "start",
    ],
    [
      "Added",
      failedAt(6, 0.2),
      "●●●●●●✕",
      ["complete 1", "complete 1", "complete 1", "complete 1", "complete 1", "failed 0.2"],
      "centre",
    ],
  ] satisfies [string, TimelineView, string, string[], LabelAlign][])(
    "draws a failure at %s: red, large and labelled, the rest grey, no halo",
    (_, view, milestones, lines, labelAlign) => {
      const drawing = timelineDrawing(TOP_UP_TIMELINE, view);
      const failed = drawing.milestones.find(({ state }) => state === "failed");
      expect({
        ...summary(drawing),
        failed: failed && `${failed.size} ${failed.label} ${failed.labelAlign}`,
      }).toEqual({
        milestones,
        current: failed?.id,
        halo: null,
        lines,
        failed: `large Failed ${labelAlign}`,
      });
    },
  );

  it("keeps the designer's spacing between the rings", () => {
    const { lines } = timelineDrawing(TOP_UP_TIMELINE, done);
    expect(lines.map(({ weight }) => weight)).toEqual([18.5, 48, 22.5, 22.5, 48, 16]);
    expect(timelineInsets(TOP_UP_TIMELINE)).toEqual({ start: 18.5, end: 16 });
  });

  it("renames a milestone once the drawing reaches the spec's milestone", () => {
    const spec: TimelineSpec = {
      ...TOP_UP_TIMELINE,
      milestones: TOP_UP_TIMELINE.milestones.map((milestone) =>
        milestone.id === "received"
          ? { ...milestone, label: "Converted", relabel: { from: 5, label: "Received" } }
          : milestone,
      ) as unknown as TimelineSpec["milestones"],
    };
    const labelAt = (view: TimelineView, shown?: number) =>
      timelineDrawing(spec, view, shown).milestones[3]!.label;
    expect(labelAt(current("active", 4, 0.5))).toBe("Converted");
    expect(labelAt(current("active", 5, 0.5))).toBe("Received");
    expect(labelAt(current("active", 5, 0.5), 4)).toBe("Converted");
    expect(labelAt(failedAt(6, 0.2))).toBe("Received");
    expect(labelAt(done)).toBe("Received");
  });
});

describe("top-up overall progress", () => {
  it.each([
    ["the first line filling", current("active", 0, 0.6), 0.6 / 6],
    ["a delayed fourth line", current("delayed", 3, 0.3), 3.3 / 6],
    ["a failed line", failedAt(3, 0.6), 2.6 / 6],
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

describe("top-up list progress", () => {
  it.each([
    ["before the timeline", undefined, { value: 0, tone: "waiting", delayed: false }],
    [
      "a delayed provider part",
      current("delayed", 1, 0.5),
      { value: 1.5 / 6, tone: "delayed", delayed: true },
    ],
    [
      "the Polkadot part",
      current("active", 3, 0.5),
      { value: 3.5 / 6, tone: "active", delayed: false },
    ],
  ] as const)("rings %s", (_, view, expected) => {
    expect(listProgress(view && { view })).toEqual(expected);
  });
});
