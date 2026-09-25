<script setup lang="ts">
// The return-funds guide behind a refunded withdrawal: the swap refunded DOT to the withdrawal's
// own key on Asset Hub, and these are the steps that walk it into a wallet the user controls.
// The address comes straight off the record's public key; the secret is derived on tap, never
// on load, and only when the derivation agrees with that address.
import { computed } from "vue";
import { AccountId } from "polkadot-api";
import type { WithdrawalRecord } from "../../funding/requests/model";
import { useRecoveryKey } from "../../composables/useRecoveryKey";
import CopiedPill from "../ui/CopiedPill.vue";
import PillButton from "../ui/PillButton.vue";
import RecoveryAddressCard from "../ui/RecoveryAddressCard.vue";
import RecoveryKeyCard from "../ui/RecoveryKeyCard.vue";

const props = defineProps<{
  record: WithdrawalRecord;
  /** Preview deck only: a canned secret so the revealed frame can be staged. */
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
  autoReveal: () => props.previewSecret !== undefined,
  resolve: async () => {
    if (props.previewSecret !== undefined) {
      return { address: recorded.value, secret: props.previewSecret };
    }
    const live = await import("~~/lib/withdraw-live");
    return await live.revealWithdrawKey(props.record.key.label);
  },
});

const steps = [
  { text: "Your DOT returns to this address.", card: "address" },
  { text: "Import this key into any wallet that supports Polkadot.", card: "key" },
  { text: "Transfer your DOT to any Polkadot address you control", card: null },
] as const;
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col overflow-y-auto pb-6" aria-label="Return funds">
    <div class="flex shrink-0 flex-col gap-2 text-center">
      <h1 class="text-display-s text-fg-primary">Return funds</h1>
      <p class="text-paragraph-l text-fg-primary">
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
          <RecoveryKeyCard label="Private key" :secret="secret" :masked="masked" @toggle="toggleKey" />
          <p v-if="unavailable" class="text-center text-body-s text-fg-error" role="alert">
            The key can't be loaded on this device. Open this withdrawal in the Polkadot App to
            reach it.
          </p>
        </template>
      </li>
    </ol>

    <div class="mt-auto shrink-0 pt-8">
      <CopiedPill />
      <PillButton variant="tertiary" class="w-full" @click="emit('back')">Back</PillButton>
    </div>
  </section>
</template>
