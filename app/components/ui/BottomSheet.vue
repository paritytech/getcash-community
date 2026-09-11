<script setup lang="ts">
// The app's modal primitive: a bottom sheet over a dimmed overlay. An overlay tap emits "dismiss";
// the parent decides whether to close.
defineProps<{ open: boolean }>();
defineEmits<{ dismiss: [] }>();
</script>

<template>
  <div v-if="open" class="fixed inset-0 z-50">
    <button
      type="button"
      class="absolute inset-0 bg-surface-overlay"
      aria-label="Dismiss"
      @click="$emit('dismiss')"
    />
    <div class="absolute inset-x-0 bottom-0 mx-auto w-full max-w-md px-4 pb-6">
      <div
        role="dialog"
        aria-modal="true"
        class="relative overflow-hidden rounded-container bg-surface-container shadow-3"
      >
        <slot />
      </div>
    </div>
  </div>
</template>
