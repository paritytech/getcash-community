<script setup lang="ts">
// Network picker. Lists only networks with a token that can pay for this amount.
import { computed } from "vue";
import { networkIcon } from "../../utils/icons";
import { useFlowStore } from "../../stores/flow";
import { useOffersStore, type NetworkRow } from "../../stores/offers";
import { useSessionStore } from "../../stores/session";

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

/** "list" while any network is offered; otherwise "paused" or "too-small". */
const state = computed<"list" | "paused" | "too-small">(() => {
  if (offers.offeredNetworks.length > 0) return "list";
  return offers.paused ? "paused" : "too-small";
});

/** Row subtitle while the purchase starts or the floors are still being learned. */
function subtitle(network: NetworkRow): string | undefined {
  if (flow.starting && network.chain === flow.srcChain.chain) return "Starting…";
  return network.checking ? "Checking…" : undefined;
}

function pick(network: NetworkRow) {
  if (flow.starting) return;
  flow.pickNetwork(network.chain);
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <h1 class="text-display-l text-fg-primary">Select network</h1>

    <ul v-if="state === 'list'" class="mt-6 flex flex-col gap-6">
      <OptionRow
        v-for="network in offers.offeredNetworks"
        :key="network.chain"
        :icon="networkIcon(network.chain)"
        :label="network.label"
        :subtitle="subtitle(network)"
        @select="pick(network)"
      />
    </ul>

    <div v-else class="mt-6 flex flex-col gap-4">
      <!-- "Paused" covers every way the swap network can fail to answer. -->
      <template v-if="state === 'paused'">
        <p class="text-body-m text-fg-secondary">
          Crypto top-ups aren't available right now: the swap network isn't answering. It is usually
          back within the hour.
        </p>
        <button
          type="button"
          class="self-start rounded-medium bg-action-secondary px-4 py-2.5 text-label-m text-fg-primary transition-colors hover:bg-action-secondary-hover"
          @click="offers.relearn()"
        >
          Try again
        </button>
      </template>
      <template v-else>
        <p class="text-body-m text-fg-secondary">
          No network can do a top-up of {{ session.amountHuman }} $CASH.
          <template v-if="smallestCash">
            The smallest crypto top-up right now is about {{ smallestCash }} $CASH.
          </template>
        </p>
        <button
          type="button"
          class="self-start rounded-medium bg-action-secondary px-4 py-2.5 text-label-m text-fg-primary transition-colors hover:bg-action-secondary-hover"
          @click="emit('changeAmount')"
        >
          Change amount
        </button>
      </template>
    </div>
  </div>
</template>
