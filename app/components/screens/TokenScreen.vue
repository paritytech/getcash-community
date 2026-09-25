<script setup lang="ts">
// Token picker: every coin on the chosen network, the ones that clear their floor for this
// amount first and the rest greyed with why, under a reminder of the network already picked.
// Picking a row starts the purchase.
import { computed } from "vue";
import { networkIcon, tokenIcon } from "../../utils/icons";
import { groupTokens, tokenSubtitle } from "../../funding/source-groups";
import { useFreshFloors } from "../../composables/useFreshFloors";
import { useFlowStore } from "../../stores/flow";
import { isPickable, useOffersStore, type TokenRow } from "../../stores/offers";

const flow = useFlowStore();
const offers = useOffersStore();
useFreshFloors();

const groups = computed(() => groupTokens(offers.tokensOf(flow.srcChain.chain)));

function pick(token: TokenRow) {
  if (flow.starting) return;
  flow.selectSource(flow.srcChain.chain, token.asset);
  void flow.startPurchase();
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- The cards bleed past the 24px content gutter to the design's 16px inset. -->
    <NetworkRecapBar
      class="-mx-2"
      :label="flow.srcChain.label"
      :icon="networkIcon(flow.srcChain.chain)"
    />

    <!-- Floors still being learned: skeleton rows stand in for the tokens. -->
    <ul
      v-if="offers.awaitingFloors"
      class="-mx-2 mt-4 flex flex-col gap-2"
      aria-label="Loading tokens"
    >
      <OptionRow v-for="n in 2" :key="n" skeleton />
    </ul>

    <div v-else class="-mx-2 mt-4 flex min-h-0 flex-col gap-4 overflow-y-auto pb-6">
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
          v-for="token in group.rows"
          :key="token.sourceId"
          :icon="tokenIcon(token.asset)"
          :label="token.asset"
          :subtitle="tokenSubtitle(token.offer)"
          :disabled="!isPickable(token.offer)"
          :busy="flow.starting && token.asset === flow.srcAsset"
          @select="pick(token)"
        />
      </ul>
    </div>
  </div>
</template>
