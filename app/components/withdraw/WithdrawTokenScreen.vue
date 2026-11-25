<script setup lang="ts">
// Token picker for a withdrawal: the tokens on the network, under a bar that names it.
import {
  destinationTokenIcon,
  type WithdrawDestination,
  type WithdrawNetwork,
} from "../../withdraw/destinations";

defineProps<{ network: WithdrawNetwork }>();
const emit = defineEmits<{ pick: [destination: WithdrawDestination] }>();
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- The cards bleed past the 24px content gutter to the design's 16px inset. -->
    <NetworkRecapBar class="-mx-2" :label="network.label" :icon="network.icon" />

    <ul class="-mx-2 mt-4 flex flex-col gap-2 overflow-y-auto pb-cta">
      <OptionRow
        v-for="destination in network.destinations"
        :key="destination.id"
        :icon="destinationTokenIcon(destination)"
        :label="destination.asset"
        @select="emit('pick', destination)"
      />
    </ul>
  </div>
</template>
