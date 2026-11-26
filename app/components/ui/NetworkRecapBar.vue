<script setup lang="ts">
// The network a token picker's tokens are on: its label and icon on the design's container bar.
defineProps<{ label: string; icon: string }>();
</script>

<template>
  <div
    class="recap-bar flex h-10 shrink-0 items-center justify-between bg-surface-container px-3 text-body-m text-fg-primary"
  >
    <span>Network</span>
    <span class="flex items-center gap-2">
      {{ label }}
      <img :src="icon" alt="" class="size-6 rounded-full" />
    </span>
  </div>
</template>

<style scoped>
/* 24px; the radius scale has no semantic step this size. */
.recap-bar {
  border-radius: var(--scale-radius-large);
}
</style>
