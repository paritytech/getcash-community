<script setup lang="ts">
// Token picker for a withdrawal: the tokens on the chosen network, each judged by its own offer
// for the amount on screen, under a reminder of the network already picked. `skeleton` shows the
// design's loading placeholders instead.
import { computed } from "vue";
import { useWithdrawOffersStore } from "../../stores/withdraw-offers";
import {
  destinationTokenIcon,
  type WithdrawDestination,
  type WithdrawNetwork,
} from "../../withdraw/destinations";

const props = withDefaults(defineProps<{ network: WithdrawNetwork; skeleton?: boolean }>(), {
  skeleton: false,
});
const emit = defineEmits<{ pick: [destination: WithdrawDestination] }>();

const offers = useWithdrawOffersStore();

const rows = computed(() =>
  props.network.destinations.map((destination) => ({
    destination,
    state: offers.rowFor(destination),
  })),
);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- The cards bleed past the 24px content gutter to the design's 16px inset. -->
    <NetworkRecapBar
      class="-mx-2"
      :label="network.label"
      :icon="network.icon"
      :skeleton="skeleton"
    />

    <ul v-if="skeleton" class="-mx-2 mt-4 flex flex-col gap-2" aria-label="Loading tokens">
      <OptionRow v-for="n in 2" :key="n" skeleton />
    </ul>

    <ul v-else class="-mx-2 mt-4 flex flex-col gap-2 overflow-y-auto pb-6">
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
