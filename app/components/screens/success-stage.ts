/**
 * The journey's success screen: `none` until the top-up succeeds, then `drawing` while the timeline
 * completes Added, `playing` while the success motion runs, or `shown` at once.
 */
export type SuccessStage = "none" | "drawing" | "playing" | "shown";

export type SuccessEvent =
  /** The top-up succeeded. The motion plays only from a timeline on screen. */
  | { kind: "succeeded"; animate: boolean }
  /** The timeline drew its last tick. */
  | { kind: "drawn" };

/** A journey that opens on a success shows its end state, with no motion. */
export const openingSuccessStage = (succeeded: boolean): SuccessStage =>
  succeeded ? "shown" : "none";

export function nextSuccessStage(stage: SuccessStage, event: SuccessEvent): SuccessStage {
  if (event.kind === "drawn") return stage === "drawing" ? "playing" : stage;
  if (stage !== "none") return stage;
  return event.animate ? "drawing" : "shown";
}
