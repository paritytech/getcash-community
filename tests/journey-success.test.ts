// The journey's success as the screens share it: the motion plays only from a timeline that was
// on screen when the success arrived, and the band keeps its last words once it did.

import { describe, expect, it } from "vitest";
import { nextTick, ref } from "vue";
import { useJourneySuccess } from "../app/composables/useJourneySuccess";
import type { TimelineView } from "../app/funding/timeline/types";

const ACTIVE: TimelineView = {
  state: "active",
  phase: 2,
  milestones: ["complete", "complete", "complete", "upcoming", "upcoming", "upcoming", "upcoming"],
  lines: [1, 1, 0.3, 0, 0, 0],
};
const DONE: TimelineView = {
  state: "done",
  milestones: Array(7).fill("complete") as TimelineView["milestones"],
  lines: [1, 1, 1, 1, 1, 1],
};

function journey(view: TimelineView | undefined, succeeded = false) {
  const done = ref(succeeded);
  const shown = ref(view);
  const message = ref<string | null>("Converting your Cash");
  const success = useJourneySuccess({
    succeeded: done,
    view: shown,
    message,
    detail: () => null,
  });
  return { done, shown, message, ...success };
}

describe("journey success", () => {
  it("opens on a success at its end state", () => {
    expect(journey(DONE, true).success.value).toBe("shown");
  });

  it("draws the last tick, then plays, from a timeline that was on screen", async () => {
    const { done, shown, success, drawn } = journey(ACTIVE);
    expect(success.value).toBe("none");
    done.value = true;
    shown.value = DONE;
    await nextTick();
    expect(success.value).toBe("drawing");
    drawn();
    expect(success.value).toBe("playing");
  });

  it("shows the end state at once when the success arrives with the timeline", async () => {
    // The record jumps from the band alone to sent in one fold: a timeline mounted already
    // complete draws no last tick, so waiting for one would never end.
    const { done, shown, success } = journey(undefined);
    done.value = true;
    shown.value = DONE;
    await nextTick();
    expect(success.value).toBe("shown");
  });

  it("keeps the band's last words once the journey succeeded", async () => {
    const { done, message, band } = journey(ACTIVE);
    message.value = "Sending your DOT";
    await nextTick();
    expect(band.value.message).toBe("Sending your DOT");
    done.value = true;
    message.value = null;
    await nextTick();
    expect(band.value.message).toBe("Sending your DOT");
  });
});
