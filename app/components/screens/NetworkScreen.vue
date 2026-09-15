<script setup lang="ts">
// Network picker. Lists only networks with a token that can pay for this amount; skeleton rows
// stand in while the floors are still being learned.
import { computed } from "vue";
import { networkIcon } from "../../utils/icons";
import { useFlowStore } from "../../stores/flow";
import { useOffersStore, type NetworkRow } from "../../stores/offers";
import { useSessionStore } from "../../stores/session";
import SecondaryButton from "../ui/SecondaryButton.vue";

const emit = defineEmits<{ changeAmount: [] }>();

const flow = useFlowStore();
const offers = useOffersStore();
const session = useSessionStore();

/**
 * The smallest purchase any token would take, in whole CASH. Null when no token reported a floor.
 */
const smallestCash = computed<string | null>(() => {
  let smallest: bigint | null = null;
  for (const network of offers.networks) {
    for (const token of network.tokens) {
      if (token.offer.state !== "too-small" || token.offer.minimumCashBase === null) continue;
      if (smallest === null || token.offer.minimumCashBase < smallest) {
        smallest = token.offer.minimumCashBase;
      }
    }
  }
  return smallest === null ? null : ((smallest + 999_999n) / 1_000_000n).toString();
});

/** "loading" until the floors are learned, "list" while any network is offered; otherwise
 *  "paused" or "too-small". */
const state = computed<"loading" | "list" | "paused" | "too-small">(() => {
  if (offers.floors === null) return "loading";
  if (offers.offeredNetworks.length > 0) return "list";
  return offers.paused ? "paused" : "too-small";
});

/** Row subtitle while the floors are still being answered for this network. */
function subtitle(network: NetworkRow): string | undefined {
  return network.checking ? "Checking…" : undefined;
}

function pick(network: NetworkRow) {
  if (flow.starting) return;
  flow.pickNetwork(network.chain);
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- The cards bleed past the 24px content gutter to the design's 16px inset. -->
    <ul v-if="state === 'loading'" class="-mx-2 flex flex-col gap-2" aria-label="Loading networks">
      <OptionRow v-for="n in 5" :key="n" skeleton />
    </ul>

    <ul v-else-if="state === 'list'" class="-mx-2 flex flex-col gap-2 overflow-y-auto pb-6">
      <OptionRow
        v-for="network in offers.offeredNetworks"
        :key="network.chain"
        :icon="networkIcon(network.chain)"
        :label="network.label"
        :subtitle="subtitle(network)"
        :busy="flow.starting && network.chain === flow.srcChain.chain"
        @select="pick(network)"
      />
    </ul>

    <div v-else class="flex flex-col gap-4">
      <!-- "Paused" covers every way the swap network can fail to answer. -->
      <template v-if="state === 'paused'">
        <p class="text-body-m text-fg-secondary">
          Crypto top-ups aren't available right now: the swap network isn't answering. It is usually
          back within the hour.
        </p>
        <SecondaryButton class="self-start" @click="offers.relearn()">Try again</SecondaryButton>
      </template>
      <template v-else>
        <p class="text-body-m text-fg-secondary">
          No network can do a top-up of {{ session.amountHuman }} $CASH.
          <template v-if="smallestCash">
            The smallest crypto top-up right now is about {{ smallestCash }} $CASH.
          </template>
        </p>
        <SecondaryButton class="self-start" @click="emit('changeAmount')">
          Change amount
        </SecondaryButton>
      </template>
    </div>
  </div>
</template>
