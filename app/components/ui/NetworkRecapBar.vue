<script setup lang="ts">
// The token picker's reminder of the network already picked: its label and icon on the design's
// container bar. `skeleton` renders the bar as an empty loading placeholder.
withDefaults(
  defineProps<{
    label?: string;
    icon?: string;
    skeleton?: boolean;
  }>(),
  {
    label: "",
    icon: "",
    skeleton: false,
  },
);
</script>

<template>
  <div
    class="recap-bar flex h-10 shrink-0 items-center justify-between bg-surface-container px-3 text-body-m text-fg-primary"
    :class="{ 'animate-pulse': skeleton }"
    :aria-hidden="skeleton || undefined"
  >
    <template v-if="!skeleton">
      <span>Network selected</span>
      <span class="flex items-center gap-2">
        {{ label }}
        <img :src="icon" alt="" class="size-6 rounded-full" />
      </span>
    </template>
  </div>
</template>

<style scoped>
/* 24px; the radius scale has no semantic step this size. */
.recap-bar {
  border-radius: var(--scale-radius-large);
}
</style>
