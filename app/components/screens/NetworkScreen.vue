<script setup lang="ts">
// Network picker. Every network the catalog knows, in two groups: the ones with a token that can
// pay for this amount, then the ones that cannot, greyed and saying why. Skeleton rows stand in
// while the floors are still being learned.
import { computed } from "vue";
import { networkIcon } from "../../utils/icons";
import { groupNetworks, networkSubtitle } from "../../funding/source-groups";
import { useFreshFloors } from "../../composables/useFreshFloors";
import { useFlowStore } from "../../stores/flow";
import { isNetworkPickable, useOffersStore, type NetworkRow } from "../../stores/offers";

const flow = useFlowStore();
const offers = useOffersStore();
useFreshFloors();

const groups = computed(() => groupNetworks(offers.networks));

function pick(network: NetworkRow) {
  if (flow.starting) return;
  flow.pickNetwork(network.chain);
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- The cards bleed past the 24px content gutter to the design's 16px inset. -->
    <ul
      v-if="offers.awaitingFloors"
      class="-mx-2 flex flex-col gap-2"
      aria-label="Loading networks"
    >
      <OptionRow v-for="n in 5" :key="n" skeleton />
    </ul>

    <div v-else class="-mx-2 flex min-h-0 flex-col gap-4 overflow-y-auto pb-6">
      <ul
        v-for="group in groups"
        :key="group.label"
        class="flex flex-col gap-2"
        :aria-label="group.label"
      >
        <li v-if="groups.length > 1" class="px-2 pt-2 text-overline text-fg-tertiary">
          {{ group.label }}
        </li>
        <OptionRow
          v-for="network in group.rows"
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
  </div>
</template>
