<script setup lang="ts">
// Network picker for a top-up. Every network the catalog knows, judged against the amount on
// screen: the ones with a token that can pay for it are pickable, the ones that cannot say why.
// The list, its order and its skeletons are OptionList's; a pick in flight keeps its rows on
// screen, spinner and all.
import { computed } from "vue";
import { networkIcon } from "../../utils/icons";
import { networkSubtitle } from "../../funding/source-groups";
import type { OptionListRow } from "../../utils/option-list";
import { useFreshFloors } from "../../composables/useFreshFloors";
import { useFlowStore } from "../../stores/flow";
import { isNetworkPickable, useOffersStore, type NetworkRow } from "../../stores/offers";

interface NetworkOption extends OptionListRow {
  network: NetworkRow;
}

const flow = useFlowStore();
const offers = useOffersStore();
useFreshFloors();

const rows = computed<NetworkOption[]>(() =>
  offers.networks.map((network) => ({
    key: network.chain,
    icon: networkIcon(network.chain),
    label: network.label,
    subtitle: networkSubtitle(network),
    pickable: isNetworkPickable(network),
    busy: flow.starting && network.chain === flow.srcChain.chain,
    network,
  })),
);

function pick({ network }: NetworkOption) {
  if (flow.starting) return;
  flow.pickNetwork(network.chain);
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <OptionList
      :rows="rows"
      :loading="offers.awaitingNetworks && !flow.starting"
      label="Networks"
      @pick="pick"
    />

    <PoweredBy class="mt-auto mb-4 pt-3" provider="Chainflip" />
  </div>
</template>
