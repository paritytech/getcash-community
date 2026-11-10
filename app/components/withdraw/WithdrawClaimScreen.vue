<script setup lang="ts">
// Shows USDC released to the seller's claimer, moved by importing the claim key into a wallet.
import { computed } from "vue";
import { formatBaseUnits } from "@getsome/meld";
import type { WithdrawalRecord } from "../../funding/requests/model";
import { saleVaultProxyOfRecord } from "../../funding/requests/transitions/withdrawal";
import { useRecoveryKey } from "../../composables/useRecoveryKey";
import {
  saleVaultProxyRelayable,
  useSaleVaultProxyStatus,
} from "../../composables/useSaleVaultProxyStatus";
import CopiedPill from "../ui/CopiedPill.vue";
import PillButton from "../ui/PillButton.vue";
import RecoveryAddressCard from "../ui/RecoveryAddressCard.vue";
import RecoveryKeyCard from "../ui/RecoveryKeyCard.vue";
import ScreenFrame from "../ui/ScreenFrame.vue";

const props = defineProps<{ record: WithdrawalRecord }>();
const emit = defineEmits<{ back: [] }>();

const kept = computed(() => saleVaultProxyOfRecord(props.record));
const claimer = computed(() => kept.value?.claimerAddress ?? null);

const { status: proxy } = useSaleVaultProxyStatus(() =>
  kept.value === undefined
    ? undefined
    : { fundingRequestId: kept.value.fundingRequestId, chainId: kept.value.chainId },
);
/** What sits on the claimer now, in base units of the lane's USDC. */
const claimed = computed(() => (proxy.value === null ? 0n : saleVaultProxyRelayable(proxy.value)));
const amount = computed(() =>
  kept.value === undefined || claimed.value === 0n
    ? null
    : `${formatBaseUnits(kept.value.token, claimed.value)} USDC`,
);

const {
  address,
  secret,
  masked,
  unavailable,
  toggle: toggleKey,
} = useRecoveryKey({
  identity: () => props.record.key.label,
  known: () => claimer.value,
  resolve: async () => {
    if (claimer.value === null) return null;
    const live = await import("~~/lib/withdraw-live");
    return await live.revealClaimKey(props.record.key.label, claimer.value);
  },
});

const KEY_STEPS = [
  { text: "Your USDC is on this address.", card: "address" },
  { text: "Import this key into any wallet that supports Arbitrum.", card: "key" },
  { text: "Sending from that wallet needs a little ETH on Arbitrum for the fee.", card: null },
] as const;
</script>

<template>
  <ScreenFrame aria-label="Move your USDC">
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="flex shrink-0 flex-col gap-2 text-center">
        <h1 class="text-display-s text-fg-primary">Move your USDC</h1>
        <p v-if="amount" class="text-paragraph-l text-fg-primary">
          {{ amount }} from this sale is on your own Arbitrum address. Move it with the key below.
        </p>
        <p v-else class="text-paragraph-l text-fg-primary">
          Funds from this sale that are sent to your own Arbitrum address show here.
        </p>
      </div>

      <ol v-if="claimer" class="mt-8 flex shrink-0 flex-col gap-6">
        <li v-for="(step, index) in KEY_STEPS" :key="index" class="flex flex-col gap-3">
          <div class="flex items-center gap-3">
            <span
              class="flex size-8 shrink-0 items-center justify-center rounded-full bg-fg-primary text-heading-l text-fg-primary-inverted"
              aria-hidden="true"
            >
              {{ index + 1 }}
            </span>
            <p class="text-body-m text-fg-primary">{{ step.text }}</p>
          </div>

          <RecoveryAddressCard
            v-if="step.card === 'address' && address"
            label="Address on Arbitrum"
            :address="address"
          />
          <template v-else-if="step.card === 'key'">
            <RecoveryKeyCard
              label="Private key"
              :secret="secret"
              :masked="masked"
              @toggle="toggleKey"
            />
            <p v-if="unavailable" class="text-center text-body-s text-fg-error" role="alert">
              The key can't be loaded on this device. Open this withdrawal in the Polkadot App to
              reach it.
            </p>
          </template>
        </li>
      </ol>
    </div>

    <template #actions>
      <div class="pt-8">
        <CopiedPill />
        <PillButton variant="tertiary" class="w-full" @click="emit('back')">Back</PillButton>
      </div>
    </template>
  </ScreenFrame>
</template>
