<script setup lang="ts">
// Network picker for a withdrawal: every network the design lists, judged against the amount on
// screen. Asset Hub is always open; a Chainflip network is dimmed with the reason when this build
// cannot run it, while its floor is being learned, or when the amount is under that floor.
import { computed, onMounted } from "vue";
import { useWithdrawFloorStore } from "../../stores/withdraw-floor";
import { WITHDRAW_NETWORKS, type WithdrawNetwork } from "../../withdraw/destinations";

const props = defineProps<{
  /** The CASH to withdraw, base units; null while it cannot be read. */
  amount: bigint | null;
}>();
const emit = defineEmits<{ pick: [network: WithdrawNetwork] }>();

const floor = useWithdrawFloorStore();
onMounted(() => {
  void floor.learn();
});

const rows = computed(() =>
  WITHDRAW_NETWORKS.map((network) => ({
    network,
    state: floor.networkStateOf(network, props.amount),
  })),
);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- The cards bleed past the 24px content gutter to the design's 16px inset. -->
    <ul class="-mx-2 flex flex-col gap-2 overflow-y-auto pb-6">
      <OptionRow
        v-for="{ network, state } in rows"
        :key="network.chain"
        :icon="network.icon"
        :label="network.label"
        :subtitle="state.subtitle"
        :disabled="!state.pickable"
        @select="emit('pick', network)"
      />
    </ul>
  </div>
</template>
