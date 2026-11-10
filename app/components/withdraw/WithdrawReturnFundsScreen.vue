<script setup lang="ts">
// Walks what a withdrawal's own Asset Hub key holds into a wallet, the secret derived on tap.
import { computed } from "vue";
import { AccountId } from "polkadot-api";
import type { WithdrawalRecord } from "../../funding/requests/model";
import { useRecoveryKey } from "../../composables/useRecoveryKey";
import { directRecoveryNotes } from "../../utils/recovery";
import { saleAssetOnKey } from "../../withdraw/timeline/failure";
import CopiedPill from "../ui/CopiedPill.vue";
import PillButton from "../ui/PillButton.vue";
import RecoveryAddressCard from "../ui/RecoveryAddressCard.vue";
import RecoveryKeyCard from "../ui/RecoveryKeyCard.vue";
import ScreenFrame from "../ui/ScreenFrame.vue";

const props = defineProps<{
  record: WithdrawalRecord;
  /** Preview deck only: a canned secret for the reveal. */
  previewSecret?: string;
}>();
const emit = defineEmits<{ back: [] }>();

/** The key on Asset Hub, where the refund landed: prefix 0 of the record's own public key. */
const recorded = computed(() => AccountId(0).dec(props.record.key.publicKeyHex as `0x${string}`));

// `deriveKeypair` addresses at prefix 0 too, so what comes back is comparable to `recorded` as it
// stands; a disagreement means the root answering now is not the one the record was written under.
const {
  address,
  secret,
  masked,
  unavailable,
  toggle: toggleKey,
} = useRecoveryKey({
  identity: () => props.record.key.label,
  known: () => recorded.value,
  resolve: async () => {
    if (props.previewSecret !== undefined) {
      return { address: recorded.value, secret: props.previewSecret };
    }
    const live = await import("~~/lib/withdraw-live");
    return await live.revealWithdrawKey(props.record.key.label);
  },
});

/** The asset on a sale's key, null for a crypto refund, which returns DOT. */
const saleAsset = computed(() => saleAssetOnKey(props.record));
// Both branches reveal the same raw seed, so both read the same notes
const notes = computed(() => directRecoveryNotes(saleAsset.value ?? "DOT"));
const steps = computed(
  () =>
    [
      {
        text:
          notes.value.gasNote ??
          (saleAsset.value === null
            ? "Your DOT returns to this address."
            : `Your ${saleAsset.value} is on this address.`),
        card: "address",
      },
      { text: notes.value.importNote, card: "key" },
      { text: notes.value.transferNote, card: null },
    ] as const,
);
const title = computed(() => (saleAsset.value === null ? "Return funds" : "Recover funds"));
</script>

<template>
  <ScreenFrame :aria-label="title">
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="flex shrink-0 flex-col gap-2 text-center">
        <h1 class="text-display-s text-fg-primary">{{ title }}</h1>
        <p v-if="saleAsset" class="text-paragraph-l text-fg-primary">
          Anything left from this sale is on this withdrawal's own account.
        </p>
        <p v-else class="text-paragraph-l text-fg-primary">
          Your <span class="font-semibold">DOT</span> is on its way back to your recovery address.
        </p>
      </div>

      <ol class="mt-8 flex shrink-0 flex-col gap-6">
        <li v-for="(step, index) in steps" :key="index" class="flex flex-col gap-3">
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
            label="Address on Asset Hub"
            :address="address"
          />
          <template v-else-if="step.card === 'key'">
            <RecoveryKeyCard
              :label="notes.secretLabel"
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
