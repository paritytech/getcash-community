import { describe, expect, it } from "vitest";
import {
  ago,
  checked,
  joinDetail,
  LIVE_DETAIL_MS,
  liveClock,
  liveDetail,
  stages,
  stepSince,
} from "../app/funding/timeline/live";
import { TIMELINE_CADENCE_MS } from "../app/funding/timeline/timelines";
import type { TimelineView } from "../app/funding/timeline/types";

const SECOND = 1_000;
const T = 1_700_000_000_000;

const phase = (index: number): TimelineView => ({
  state: "active",
  phase: index,
  milestones: [],
  lines: [],
});

describe("live detail clock", () => {
  it("runs on a grid of whole timeline ticks", () => {
    expect(LIVE_DETAIL_MS % TIMELINE_CADENCE_MS).toBe(0);
  });

  it("is absent for the first 3 s on a step", () => {
    expect(liveClock(T, T)).toBeUndefined();
    expect(liveClock(T + 3 * SECOND - 1, T)).toBeUndefined();
  });

  it("moves only on 3 s ticks from the step's start", () => {
    expect(liveClock(T + 3 * SECOND, T)).toBe(T + 3 * SECOND);
    expect(liveClock(T + 4 * SECOND, T)).toBe(T + 3 * SECOND);
    expect(liveClock(T + 5 * SECOND, T)).toBe(T + 3 * SECOND);
    expect(liveClock(T + 6 * SECOND, T)).toBe(T + 6 * SECOND);
    expect(liveClock(T + 20 * SECOND, T + SECOND)).toBe(T + 19 * SECOND);
  });

  it("keeps the step's start while the view stays on the step, and resets when it moves", () => {
    expect(stepSince(phase(2), phase(2), T, T + 10 * SECOND)).toBe(T);
    expect(stepSince(phase(3), phase(2), T, T + 10 * SECOND)).toBe(T + 10 * SECOND);
    // Nothing shown before: the start given stands.
    expect(stepSince(phase(2), undefined, T, T + 10 * SECOND)).toBe(T);
  });
});

describe("live detail words", () => {
  it.each([
    [0, "just now"],
    [999, "just now"],
    [SECOND, "1s ago"],
    [59 * SECOND, "59s ago"],
    [60 * SECOND, "1min ago"],
    [59 * 60 * SECOND, "59min ago"],
    [60 * 60 * SECOND, "1h ago"],
    [-5 * SECOND, "just now"],
  ])("says %i ms as %s", (ms, text) => {
    expect(ago(ms)).toBe(text);
  });

  it("names a read on the live clock, and nothing without one", () => {
    expect(checked("Checked", T - 2 * SECOND, T)).toBe("Checked 2s ago");
    expect(checked("Checked", undefined, T)).toBeUndefined();
    expect(checked("Checked", T, undefined)).toBeUndefined();
  });

  it("joins the parts that are present", () => {
    expect(joinDetail("Part 2 of 4", undefined, "checked 1s ago")).toBe(
      "Part 2 of 4 · checked 1s ago",
    );
    expect(joinDetail(undefined, undefined)).toBeUndefined();
  });

  it("holds the stages back until the clock runs", () => {
    expect(liveDetail(undefined, "Prepared ✓ · Included")).toBeUndefined();
    expect(liveDetail(T, "Prepared ✓ · Included", "checked 3s ago")).toBe(
      "Prepared ✓ · Included · checked 3s ago",
    );
  });

  it("ticks the stages that are done", () => {
    expect(stages(["Registered", "Seen", "Added"], 0)).toBe("Registered · Seen · Added");
    expect(stages(["Registered", "Seen", "Added"], 2)).toBe("Registered ✓ · Seen ✓ · Added");
  });
});
