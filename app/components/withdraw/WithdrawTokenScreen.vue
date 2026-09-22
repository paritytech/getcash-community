<script setup lang="ts">
// Token picker for a withdrawal: the tokens on the chosen network, judged against the amount on
// screen, under a reminder of the network already picked.
import { computed } from "vue";
import { useWithdrawFloorStore } from "../../stores/withdraw-floor";
import {
  destinationTokenIcon,
  type WithdrawDestination,
  type WithdrawNetwork,
} from "../../withdraw/destinations";

const props = defineProps<{
  network: WithdrawNetwork;
  /** The CASH to withdraw, base units; null while it cannot be read. */
  amount: bigint | null;
}>();
const emit = defineEmits<{ pick: [destination: WithdrawDestination] }>();

const floor = useWithdrawFloorStore();

const rows = computed(() =>
  props.network.destinations.map((destination) => ({
    destination,
    state: floor.stateOf(destination, props.amount),
  })),
);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- The cards bleed past the 24px content gutter to the design's 16px inset. -->
    <div
      class="token-summary -mx-2 flex h-10 shrink-0 items-center justify-between bg-surface-container px-3 text-body-m text-fg-primary"
    >
      <span>Network selected</span>
      <span class="flex items-center gap-2">
        {{ network.label }}
        <img :src="network.icon" alt="" class="size-6 rounded-full" />
      </span>
    </div>

    <ul class="-mx-2 mt-4 flex flex-col gap-2 overflow-y-auto pb-6">
      <OptionRow
        v-for="{ destination, state } in rows"
        :key="destination.id"
        :icon="destinationTokenIcon(destination)"
        :label="destination.asset"
        :subtitle="state.subtitle"
        :disabled="!state.pickable"
        @select="emit('pick', destination)"
      />
    </ul>
  </div>
</template>

<style scoped>
/* 24px; the radius scale has no semantic step this size. */
.token-summary {
  border-radius: var(--scale-radius-large);
}
</style>
