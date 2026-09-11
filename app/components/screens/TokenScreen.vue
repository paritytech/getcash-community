<script setup lang="ts">
// Token picker: the coins on the chosen network that clear their floor for this amount, under a
// reminder of the network already picked. Picking a row starts the purchase.
import { computed } from "vue";
import { networkIcon, tokenIcon } from "../../utils/icons";
import { useFlowStore } from "../../stores/flow";
import { useOffersStore, type TokenRow } from "../../stores/offers";

const flow = useFlowStore();
const offers = useOffersStore();

const tokens = computed(() => offers.offeredTokens(flow.srcChain.chain));
/** Floors still being learned: skeleton rows stand in for the tokens. */
const loading = computed(() => offers.floors === null);

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

    <ul v-if="loading" class="-mx-2 mt-4 flex flex-col gap-2" aria-label="Loading tokens">
      <OptionRow v-for="n in 2" :key="n" skeleton />
    </ul>

    <ul v-else class="-mx-2 mt-4 flex flex-col gap-2 overflow-y-auto pb-6">
      <OptionRow
        v-for="token in tokens"
        :key="token.sourceId"
        :icon="tokenIcon(token.asset)"
        :label="token.asset"
        :busy="flow.starting && token.asset === flow.srcAsset"
        @select="pick(token)"
      />
    </ul>
    <!-- Only reachable when the amount changed underneath the network pick. -->
    <p v-if="!loading && tokens.length === 0" class="mt-4 text-body-m text-fg-secondary">
      Nothing on {{ flow.srcChain.label }} can do this amount any more.
    </p>
  </div>
</template>

<style scoped>
/* 24px; the radius scale has no semantic step this size. */
.token-summary {
  border-radius: var(--scale-radius-large);
}
</style>
