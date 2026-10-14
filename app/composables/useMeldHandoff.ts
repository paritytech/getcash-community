// Meld rail handoff. Emits "handoff" once when the provider approves the payment or it fails.

import { computed, watch } from "vue";
import { meldDepositPending } from "../funding/meld-handoff";
import { useFlowStore } from "../stores/flow";
import { useRequestsStore } from "../stores/requests";
import { useSessionStore } from "../stores/session";

export function useMeldHandoff(emit: (event: "handoff") => void) {
  const session = useSessionStore();
  const requests = useRequestsStore();
  const flow = useFlowStore();

  const depositPending = computed(() =>
    meldDepositPending({
      fundsSeen: requests.fundsSeen,
      meldHandedOff: requests.meldHandedOff,
      meldStage: requests.meldStage,
      awaitingDeposit: requests.awaitingDeposit,
    }),
  );

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
