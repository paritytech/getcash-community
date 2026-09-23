<script setup lang="ts">
// The KYC step: the provider's hosted widget, edge to edge, where the seller verifies and names
// the account to be paid into. Shaped like the buy side's `MeldPaySheet.vue`; unlike a buy there
// is no `meld:paid` message to listen for here — a sell's next milestone is the provider
// disclosing a deposit address, which only ever arrives by polling `getStatus` (see
// `useMeldWithdrawalPoll`), never pushed. Cancel stays offered the whole time this screen is up:
// nothing has moved yet, and it disappears the instant that stops being true (see
// `withdrawalCancellable`), which is enforced by the caller passing `canCancel`, not by this
// screen guessing at it.
defineProps<{ widgetUrl: string | null; canCancel: boolean; cancelling: boolean }>();
const emit = defineEmits<{ cancel: [] }>();
</script>

<template>
  <div class="flex min-h-0 w-full flex-1 flex-col">
    <!-- No background of our own behind the widget: the provider's page paints itself the moment
         it loads, and any surface we put there is wrong in half the themes for the frame it
         shows. -->
    <iframe
      v-if="widgetUrl"
      :src="widgetUrl"
      class="min-h-0 w-full flex-1 border-0"
      title="Identity verification"
      allow="camera *; clipboard-write *"
    />
    <div v-else class="flex min-h-0 w-full flex-1 items-center justify-center">
      <span
        class="size-8 animate-spin rounded-full border-[3px] border-stroke-primary border-t-fg-primary"
      />
    </div>
    <button
      v-if="canCancel"
      type="button"
      class="mx-6 mt-3 mb-4 h-12 shrink-0 rounded-medium bg-status-error text-label-l text-fg-static-white transition-colors hover:bg-status-error-hover disabled:opacity-50"
      :disabled="cancelling"
      @click="emit('cancel')"
    >
      {{ cancelling ? "Cancelling…" : "Cancel" }}
    </button>
  </div>
</template>
