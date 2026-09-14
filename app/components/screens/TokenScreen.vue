<script setup lang="ts">
// Token picker: the assets on the chosen network that clear their floor for this amount. Picking a
// row starts the purchase.
import { computed } from "vue";
import { tokenIcon } from "../../utils/icons";
import { useFlowStore } from "../../stores/flow";
import { useOffersStore, type TokenRow } from "../../stores/offers";

const flow = useFlowStore();
const offers = useOffersStore();

const tokens = computed(() => offers.offeredTokens(flow.srcChain.chain));

/** Row subtitle while the purchase starts or the floors are still being learned. */
function subtitle(token: TokenRow): string | undefined {
  if (flow.starting && token.asset === flow.srcAsset) return "Starting…";
  return token.offer.state === "checking" ? "Checking…" : undefined;
}

function pick(token: TokenRow) {
  if (flow.starting) return;
  flow.selectSource(flow.srcChain.chain, token.asset);
  void flow.startPurchase();
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <h1 class="text-display-l text-fg-primary">Which token?</h1>
    <ul class="mt-6 flex flex-col gap-6">
      <OptionRow
        v-for="token in tokens"
        :key="token.sourceId"
        :icon="tokenIcon(token.asset)"
        :label="token.asset"
        :subtitle="subtitle(token)"
        @select="pick(token)"
      />
    </ul>
    <!-- Only reachable when the amount changed underneath the network pick. -->
    <p v-if="tokens.length === 0" class="mt-6 text-body-m text-fg-secondary">
      Nothing on {{ flow.srcChain.label }} can do this amount any more.
    </p>
  </div>
</template>
