<script setup lang="ts">
// Token picker: every coin on the chosen network, the ones that clear their floor for this
// amount first and the rest greyed with why, under a reminder of the network already picked.
// While any of them is still being answered, skeleton rows stand in for the list, one per token.
// Picking a row starts the purchase, and a pick in flight keeps its rows on screen, spinner and
// all.
import { computed } from "vue";
import { networkIcon, tokenIcon } from "../../utils/icons";
import { groupTokens, tokenSubtitle } from "../../funding/source-groups";
import { useFreshFloors } from "../../composables/useFreshFloors";
import { useFlowStore } from "../../stores/flow";
import { isPickable, useOffersStore, type TokenRow } from "../../stores/offers";

const flow = useFlowStore();
const offers = useOffersStore();
useFreshFloors();

const tokens = computed(() => offers.tokensOf(flow.srcChain.chain));
const groups = computed(() => groupTokens(tokens.value));

function pick(token: TokenRow) {
  if (flow.starting) return;
  flow.selectSource(flow.srcChain.chain, token.asset);
  void flow.startPurchase();
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- The cards bleed past the 24px content gutter to the design's 16px inset. -->
    <div
      class="token-summary -mx-2 flex h-10 shrink-0 items-center justify-between bg-surface-container px-3 text-body-m text-fg-primary"
    >
      <span>Network selected</span>
      <span class="flex items-center gap-2">
        {{ flow.srcChain.label }}
        <img :src="networkIcon(flow.srcChain.chain)" alt="" class="size-6 rounded-full" />
      </span>
    </div>

    <ul
      v-if="offers.awaitingTokens(flow.srcChain.chain) && !flow.starting"
      class="-mx-2 mt-4 flex flex-col gap-2"
      aria-label="Loading tokens"
    >
      <OptionRow v-for="n in tokens.length" :key="n" skeleton />
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

<style scoped>
/* 24px; the radius scale has no semantic step this size. */
.token-summary {
  border-radius: var(--scale-radius-large);
}
</style>
