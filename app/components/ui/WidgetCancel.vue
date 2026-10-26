<script setup lang="ts">
// Cancel under a provider's page, while the payment can still be stopped, and the provider's word
// when it refused one. The page runs edge to edge, so the gutter is this control's own.
defineProps<{
  /** Whether cancelling is on offer; the notice shows either way. */
  offered: boolean;
  cancelling: boolean;
  /** The adapter is not ready to take a cancel yet. */
  ready?: boolean;
  notice?: string | null;
}>();
const emit = defineEmits<{ cancel: [] }>();
</script>

<template>
  <button
    v-if="offered"
    type="button"
    class="mx-6 mt-3 h-12 shrink-0 rounded-medium bg-status-error text-label-l text-fg-static-white transition-colors hover:bg-status-error-hover disabled:opacity-50"
    :disabled="cancelling || ready === false"
    @click="emit('cancel')"
  >
    {{ cancelling ? "Cancelling…" : "Cancel" }}
  </button>
  <p v-if="notice" class="mx-6 mt-3 text-center text-body-m text-fg-secondary" role="status">
    {{ notice }}
  </p>
</template>
