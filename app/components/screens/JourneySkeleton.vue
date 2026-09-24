<script setup lang="ts">
// The journey's own shapes while its request is being opened: the hero, the stepper card, the
// detail rows and the button it lands on. Drawn from the screen it stands in for, so nothing
// jumps when the record arrives.
import SkeletonBlock from "../ui/SkeletonBlock.vue";

withDefaults(
  defineProps<{
    /** A finished top-up has no stepper to wait for, so its skeleton leaves the card out. */
    timeline?: boolean;
  }>(),
  { timeline: true },
);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" aria-label="Opening your top-up" aria-busy="true">
    <div class="flex flex-col items-center gap-2">
      <SkeletonBlock class="size-14" />
      <SkeletonBlock class="h-14 w-44" />
      <SkeletonBlock class="h-4 w-28" />
    </div>

    <!-- The card takes the stepper's own size and 8px bleed, so it holds that place exactly. -->
    <div v-if="timeline" class="journey-skeleton-card -mx-4 mt-6 h-20 animate-pulse" />

    <div class="mt-6 flex flex-col gap-4">
      <div v-for="n in 4" :key="n" class="flex items-center justify-between gap-4">
        <SkeletonBlock class="h-4 w-2/5" />
        <SkeletonBlock class="h-4 w-1/5" />
      </div>
    </div>

    <SkeletonBlock class="mt-auto mb-6 h-12 w-full" />
  </div>
</template>

<style scoped>
/* The stepper card's own 24px; the radius scale has no semantic step this size. */
.journey-skeleton-card {
  border-radius: var(--scale-radius-large);
  background: var(--bg-action-disabled);
}
</style>
