<script setup lang="ts">
// The seller's KYC: the provider's page, edge to edge, where they verify themselves and name the
// account to be paid out to. The route reads the sale meanwhile and moves on once the provider
// names where the funds go. Cancel is offered until then, and never after.

defineProps<{
  widgetUrl: string;
  cancellable: boolean;
  cancelling: boolean;
  notice: string | null;
}>();
const emit = defineEmits<{ cancel: [] }>();
</script>

<template>
  <div class="flex min-h-0 w-full flex-1 flex-col">
    <!-- `*` delegates the features down the provider's own nested frames, where the camera for
         the ID check and any payment sheet live; see `MeldPaySheet.vue`. -->
    <iframe
      :src="widgetUrl"
      class="min-h-0 w-full flex-1 border-0"
      title="Verify with the provider"
      allow="payment *; camera *; clipboard-write *"
    />
    <button
      v-if="cancellable"
      type="button"
      class="mx-6 mt-3 mb-4 h-12 shrink-0 rounded-medium bg-status-error text-label-l text-fg-static-white transition-colors hover:bg-status-error-hover disabled:opacity-50"
      :disabled="cancelling"
      @click="emit('cancel')"
    >
      {{ cancelling ? "Cancelling…" : "Cancel" }}
    </button>
    <p v-if="notice" class="mx-6 mb-4 text-center text-body-m text-fg-secondary" role="status">
      {{ notice }}
    </p>
  </div>
</template>
