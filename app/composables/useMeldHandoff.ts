// Meld rail handoff. Emits "handoff" once when the provider approves the payment or it fails.

import { computed, watch } from "vue";
import { meldDepositPending } from "../funding/meld-handoff";
import { projectFundingProgress } from "../funding/progress";
import { useFlowStore } from "../stores/flow";
import { useSessionStore } from "../stores/session";

export function useMeldHandoff(emit: (event: "handoff") => void) {
  const session = useSessionStore();
  const flow = useFlowStore();

  const depositPending = computed(() => {
    const foreground = session.foregroundProgress;
    const progressKind = foreground
      ? projectFundingProgress({
          snapshot: foreground.snapshot,
          createdAt: foreground.startedAt,
          now: Date.now(),
        }).view.kind
      : null;
    return meldDepositPending({
      fundsSeen: session.fundsSeen,
      meldHandedOff: session.meldHandedOff,
      meldStage: session.meldStage,
      phase: session.phase,
      progressKind,
    });
  });

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
