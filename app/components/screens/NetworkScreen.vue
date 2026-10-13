<script setup lang="ts">
// Network picker. Every network the catalog knows in one unlabelled list: the ones with a token
// that can pay for this amount, then the ones that cannot, outlined and saying why. While any network is
// still being answered, skeleton rows stand in for the list, one per network, so nothing moves
// when the networks arrive. A pick in flight keeps its rows on screen, spinner and all.
import { computed } from "vue";
import { networkIcon } from "../../utils/icons";
import { networkSubtitle, sortNetworks } from "../../funding/source-groups";
import { useFreshFloors } from "../../composables/useFreshFloors";
import { useFlowStore } from "../../stores/flow";
import { isNetworkPickable, useOffersStore, type NetworkRow } from "../../stores/offers";

const flow = useFlowStore();
const offers = useOffersStore();
useFreshFloors();

const networks = computed(() => sortNetworks(offers.networks));

function pick(network: NetworkRow) {
  if (flow.starting) return;
  flow.pickNetwork(network.chain);
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- The cards bleed past the 24px content gutter to the design's 16px inset. -->
    <ul
      v-if="offers.awaitingNetworks && !flow.starting"
      class="-mx-2 flex flex-col gap-2"
      aria-label="Loading networks"
    >
      <OptionRow v-for="n in offers.networks.length" :key="n" skeleton />
    </ul>

    <ul v-else class="-mx-2 flex min-h-0 flex-col gap-2 overflow-y-auto pb-6" aria-label="Networks">
      <OptionRow
        v-for="network in networks"
        :key="network.chain"
        :icon="networkIcon(network.chain)"
        :label="network.label"
        :subtitle="networkSubtitle(network)"
        :disabled="!isNetworkPickable(network)"
        :busy="flow.starting && network.chain === flow.srcChain.chain"
        @select="pick(network)"
      />
    </ul>
  </div>
</template>
