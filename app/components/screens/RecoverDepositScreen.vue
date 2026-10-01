<script setup lang="ts">
// The way back for a Polkadot deposit the buyer does not want converted, or one left on a top-up
// that ended: the funds are on the top-up's own account, so the guide hands over its key.
import { computed } from "vue";
import { useRequestsStore } from "../../stores/requests";
import { useSessionStore } from "../../stores/session";
import { directRecoveryNotes } from "../../utils/recovery";
import RecoveryGuide, { type RecoveryStep } from "../ui/RecoveryGuide.vue";

const emit = defineEmits<{ back: [] }>();
const session = useSessionStore();
const requests = useRequestsStore();

// A record rebuilt from the worker's job keeps the address outside its deposit block.
const address = computed(() => {
  const record = requests.foregroundRecord;
  return record?.deposit?.address ?? record?.depositAddress ?? null;
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
    :reveal="session.revealDepositSecret"
    :material="address !== null"
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
