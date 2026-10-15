// The journey's success screen: the motion plays only for a success that lands on screen.

import { describe, expect, it } from "vitest";
import {
  nextSuccessStage,
  openingSuccessStage,
  type SuccessStage,
} from "../app/components/screens/success-stage";

describe("journey success stage", () => {
  it("shows a journey that opens on a success at its end state", () => {
    expect(openingSuccessStage(true)).toBe("shown");
    expect(nextSuccessStage("shown", { kind: "drawn" })).toBe("shown");
    expect(nextSuccessStage("shown", { kind: "succeeded", animate: true })).toBe("shown");
  });

  it("plays the motion after the timeline's last tick, unless it cannot animate", () => {
    const live: SuccessStage = openingSuccessStage(false);
    expect(live).toBe("none");
    expect(nextSuccessStage(live, { kind: "drawn" })).toBe("none");
    const drawing = nextSuccessStage(live, { kind: "succeeded", animate: true });
    expect(drawing).toBe("drawing");
    expect(nextSuccessStage(drawing, { kind: "drawn" })).toBe("playing");
    expect(nextSuccessStage(live, { kind: "succeeded", animate: false })).toBe("shown");
  });
});
