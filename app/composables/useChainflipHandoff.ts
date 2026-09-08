// Crypto rail handoff. Emits "handoff" once when the deposit is confirmed or the deposit window
// lapses.

import { computed, watch } from "vue";
import { chainflipDepositPending } from "../funding/chainflip-handoff";
import { projectFundingProgress } from "../funding/progress";
import { useFlowStore } from "../stores/flow";
import { useSessionStore } from "../stores/session";

export function useChainflipHandoff(emit: (event: "handoff") => void) {
  const session = useSessionStore();
  const flow = useFlowStore();

  const depositPending = computed(() => {
    const foreground = session.foregroundProgress;
    // The view kind does not depend on the clock.
    const progressKind = foreground
      ? projectFundingProgress({
          snapshot: foreground.snapshot,
          createdAt: foreground.startedAt,
          now: Date.now(),
        }).view.kind
      : null;
    return chainflipDepositPending({
      fundsSeen: session.fundsSeen,
      phase: session.phase,
      progressKind,
    });
  });

  // Not during a cancel or a resume.
  const confirmed = computed(
    () =>
      flow.screen === "journey" &&
      !session.cancelling &&
      !session.resuming &&
      !depositPending.value,
  );

  let handedOff = false;
  watch(
    confirmed,
    (isConfirmed) => {
      if (!isConfirmed || handedOff) return;
      handedOff = true;
      emit("handoff");
    },
    { immediate: true },
  );

  return { depositPending, handedOff: () => handedOff };
}
