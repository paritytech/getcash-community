<script setup lang="ts">
// Network picker for a withdrawal: every network the design lists, judged against the amount on
// screen. Asset Hub is always open; a Chainflip network cannot be picked, and says why, when this
// build cannot run it, when the provider is not answering, or when the amount is under the
// provider's minimum. The list, its order and its skeletons are OptionList's; `skeleton` forces
// the skeletons, for the preview deck.
import { computed, watch } from "vue";
import { PSM_EXTERNAL } from "@getsome/funding";
import { psmReserved } from "../../composables/useWithdrawalRequest";
import { useRequestsStore } from "../../stores/requests";
import { useWithdrawOffersStore } from "../../stores/withdraw-offers";
import type { OptionListRow } from "../../utils/option-list";
import { WITHDRAW_NETWORKS, type WithdrawNetwork } from "../../withdraw/destinations";
import ScreenFrame from "../ui/ScreenFrame.vue";

interface NetworkOption extends OptionListRow {
  network: WithdrawNetwork;
}

const props = withDefaults(
  defineProps<{
    /** The CASH to withdraw, base units; null while it cannot be read. */
    amount: bigint | null;
    skeleton?: boolean;
  }>(),
  { skeleton: false },
);
const emit = defineEmits<{ pick: [network: WithdrawNetwork] }>();

const offers = useWithdrawOffersStore();
const requests = useRequestsStore();
watch(
  () => props.amount,
  (amount) => {
    void offers.learn(amount, psmReserved(requests.openWithdrawals, PSM_EXTERNAL));
  },
  { immediate: true },
);

const rows = computed<NetworkOption[]>(() =>
  WITHDRAW_NETWORKS.map((network) => ({
    key: network.chain,
    icon: network.icon,
    label: network.label,
    ...offers.networkRowFor(network),
    network,
  })),
);
</script>

<template>
  <ScreenFrame>
    <OptionList
      :rows="rows"
      :loading="skeleton || offers.awaitingNetworks"
      label="Networks"
      @pick="emit('pick', $event.network)"
    />

    <template #actions>
      <PoweredBy provider="Chainflip" />
    </template>
  </ScreenFrame>
</template>
