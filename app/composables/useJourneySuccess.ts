import { computed, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import { nextSuccessStage, openingSuccessStage } from "../components/screens/success-stage";
import type { TimelineView } from "../funding/timeline/types";

/** The success motion brings the transaction icon in as the refresh icon spins out. */
export const SUCCESS_ICON_DELAY_MS = 910;

const reducedMotion = (): boolean =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export interface JourneySuccessInput {
  /** The journey reached its end well. */
  readonly succeeded: MaybeRefOrGetter<boolean>;
  /** The timeline on screen; absent while the journey shows its band alone. */
  readonly view: MaybeRefOrGetter<TimelineView | undefined>;
  /** The band's words under the timeline, and their detail. */
  readonly message: MaybeRefOrGetter<string | null>;
  readonly detail: MaybeRefOrGetter<string | null>;
}

/**
 * A journey's success: the stage of its motion, and the band that keeps its last words while the
 * timeline completes and leaves. The motion plays only from a timeline that was on screen when
 * the success arrived: it waits for the timeline's last tick, and a timeline mounted already
 * complete never draws one.
 */
export function useJourneySuccess({ succeeded, view, message, detail }: JourneySuccessInput) {
  const success = ref(openingSuccessStage(toValue(succeeded)));
  watch([() => toValue(succeeded), () => toValue(view)], ([done], [wasDone, shownView]) => {
    if (done === wasDone) return;
    success.value = done
      ? nextSuccessStage(success.value, {
          kind: "succeeded",
          animate: shownView !== undefined && !reducedMotion(),
        })
      : "none";
  });
  const successShown = computed(() => success.value === "playing" || success.value === "shown");
  const successPlaying = computed(() => success.value === "playing");
  /** The timeline drew its last tick. */
  const drawn = (): void => {
    success.value = nextSuccessStage(success.value, { kind: "drawn" });
  };

  const band = ref({ message: toValue(message), detail: toValue(detail) });
  watch([() => toValue(message), () => toValue(detail)], ([text, more]) => {
    if (!toValue(succeeded)) band.value = { message: text, detail: more };
  });

  return { success, successShown, successPlaying, drawn, band };
}
