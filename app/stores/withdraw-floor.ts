// The floor under a provider withdrawal, learned from Chainflip and kept while fresh, and the
// rows of the withdraw pickers judged against it for the amount on screen.

import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import { learnWithdrawFloor } from "~~/lib/withdraw-live";
import { chainflipRailOn } from "../utils/rail";
import type { WithdrawDestination, WithdrawNetwork } from "../withdraw/destinations";
import {
  destinationState,
  networkState,
  type RowState,
  type WithdrawFloor,
} from "../withdraw/floor";
import { FLOORS_STALE_MS } from "./offers";

export const useWithdrawFloorStore = defineStore("withdraw-floor", () => {
  const floor = shallowRef<WithdrawFloor>({ state: "checking" });
  /** When a known floor was learned (ms); null until then. */
  const learnedAt = ref<number | null>(null);
  let inflight: Promise<void> | null = null;

  /** Whether a pick can reach a provider at all; see `chainflipRailOn`. A ref so tests can pin it. */
  const railOn = ref(chainflipRailOn());

  const fresh = () => learnedAt.value !== null && Date.now() - learnedAt.value < FLOORS_STALE_MS;

  /** Learns the floor when nothing is known, when the answer went stale, or when the last answer
   *  was no answer. Nothing is asked while the rail is off. Repeat calls join the in-flight load. */
  function learn(): Promise<void> {
    if (!railOn.value) return Promise.resolve();
    if (inflight) return inflight;
    if (floor.value.state === "known" && fresh()) return Promise.resolve();
    inflight = learnWithdrawFloor()
      .then((learned) => {
        floor.value = learned;
        if (learned.state === "known") learnedAt.value = Date.now();
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  const stateOf = (destination: WithdrawDestination, amountCash: bigint | null): RowState =>
    destinationState(destination, amountCash, floor.value, railOn.value);

  const networkStateOf = (network: WithdrawNetwork, amountCash: bigint | null): RowState =>
    networkState(network, amountCash, floor.value, railOn.value);

  return { floor, railOn, learn, stateOf, networkStateOf };
});
