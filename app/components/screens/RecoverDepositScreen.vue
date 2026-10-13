<script setup lang="ts">
// The way back for a Polkadot deposit the buyer does not want converted, or one left on a top-up
// that ended: the funds are on the top-up's own account, so the guide hands over its key.
import { computed } from "vue";
import { useRecoveryKey } from "../../composables/useRecoveryKey";
import { useRequestsStore } from "../../stores/requests";
import { useSessionStore } from "../../stores/session";
import { directRecoveryNotes } from "../../utils/recovery";
import RecoveryGuide, { type RecoveryStep } from "../ui/RecoveryGuide.vue";

const emit = defineEmits<{ back: [] }>();
const session = useSessionStore();
const requests = useRequestsStore();

// A record rebuilt from the worker's job keeps the address outside its deposit block.
const recorded = computed(() => {
  const record = requests.foregroundRecord;
  return record?.deposit?.address ?? record?.depositAddress ?? null;
});

// The address is the record's; only the secret is read, and only on the tap. Pairing them here
// keeps the guide from ever showing a key beside an address it does not open.
const {
  address,
  secret,
  masked,
  material,
  toggle: toggleKey,
} = useRecoveryKey({
  identity: () => recorded.value,
  known: () => recorded.value,
  resolve: async () => {
    // Checked before the read, not after: the address is never the derivation's here, so with no
    // record to pair against there is nothing to hand over and no reason to touch the secret.
    if (recorded.value === null) return null;
    const found = await session.revealDepositSecret();
    return found === null ? null : { address: recorded.value, secret: found };
  },
});
const landed = computed(() => session.depositLanded);
const asset = computed(
  () => landed.value?.symbol ?? requests.foregroundRecord?.deposit?.assetSymbol ?? "",
);
const notes = computed(() => directRecoveryNotes(asset.value));
const steps = computed<RecoveryStep[]>(() => [
  { text: notes.value.gasNote ?? `Your ${asset.value} is on this address.`, card: "address" },
  { text: notes.value.importNote, card: "key" },
  { text: notes.value.transferNote, card: null },
]);
</script>

<template>
  <RecoveryGuide
    title="Recover funds"
    :steps="steps"
    :address="address"
    address-label="Address on Polkadot"
    :secret-label="notes.secretLabel"
    :secret="secret"
    :masked="masked"
    :material="material"
    @toggle="toggleKey"
    @back="emit('back')"
  >
    <template #status>
      <template v-if="landed">
        Your <span class="font-semibold">{{ landed.amount }} {{ landed.symbol }}</span> is on this
        top-up's own account.
      </template>
      <template v-else>Anything you sent to this top-up is on its own account.</template>
    </template>
  </RecoveryGuide>
</template>
