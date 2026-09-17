<script setup lang="ts">
// Network picker for a withdrawal: every network the design lists, the ones this build cannot
// run dimmed and named as such.
import { WITHDRAW_NETWORKS, type WithdrawNetwork } from "../../withdraw/destinations";

const emit = defineEmits<{ pick: [network: WithdrawNetwork] }>();
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- The cards bleed past the 24px content gutter to the design's 16px inset. -->
    <ul class="-mx-2 flex flex-col gap-2 overflow-y-auto pb-6">
      <OptionRow
        v-for="network in WITHDRAW_NETWORKS"
        :key="network.chain"
        :icon="network.icon"
        :label="network.label"
        :subtitle="network.available ? undefined : 'Not available yet'"
        :disabled="!network.available"
        @select="emit('pick', network)"
      />
    </ul>
  </div>
</template>
