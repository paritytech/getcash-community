<script setup lang="ts">
// Token picker: every token on the network, under a bar that names it. Picking a row starts the
// purchase, and the row carries the spinner while it does.
import { networkIcon, tokenIcon } from "../../utils/icons";
import { useFlowStore } from "../../stores/flow";

const flow = useFlowStore();

function pick(asset: string) {
  if (flow.starting) return;
  flow.selectSource(flow.srcChain.chain, asset);
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

    <ul class="-mx-2 mt-4 flex flex-col gap-2 overflow-y-auto pb-cta">
      <OptionRow
        v-for="asset in flow.srcChain.assets"
        :key="asset"
        :icon="tokenIcon(asset)"
        :label="asset"
        :busy="flow.starting && asset === flow.srcAsset"
        @select="pick(asset)"
      />
    </ul>
  </div>
</template>
