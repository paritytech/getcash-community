<script setup lang="ts">
// Token picker: the coins on the chosen network that clear their floor for this amount. Picking a
// row starts the purchase.
import { computed } from "vue";
import { tokenIcon } from "../../utils/icons";
import { useFlowStore } from "../../stores/flow";
import { useOffersStore, type TokenRow } from "../../stores/offers";

const flow = useFlowStore();
const offers = useOffersStore();

/** The coin's given name; assets without one (the stablecoins) read as their ticker. */
const COIN_NAMES: Readonly<Record<string, string>> = {
  BTC: "Bitcoin",
  ETH: "Ethereum",
  SOL: "Solana",
  TRX: "Tron",
};

const tokens = computed(() => offers.offeredTokens(flow.srcChain.chain));

function pick(token: TokenRow) {
  if (flow.starting) return;
  flow.selectSource(flow.srcChain.chain, token.asset);
  void flow.startPurchase();
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- The cards bleed past the 24px content gutter to the design's 16px inset. -->
    <ul class="-mx-2 flex flex-col gap-2 overflow-y-auto pb-6">
      <OptionRow
        v-for="token in tokens"
        :key="token.sourceId"
        :icon="tokenIcon(token.asset)"
        :label="COIN_NAMES[token.asset] ?? token.asset"
        :subtitle="`${flow.srcChain.label} Network`"
        :busy="flow.starting && token.asset === flow.srcAsset"
        @select="pick(token)"
      />
    </ul>
    <!-- Only reachable when the amount changed underneath the network pick. -->
    <p v-if="tokens.length === 0" class="text-body-m text-fg-secondary">
      Nothing on {{ flow.srcChain.label }} can do this amount any more.
    </p>
  </div>
</template>
