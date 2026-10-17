<script setup lang="ts">
// The timeline's card: the milestones, when there are any, over the message band.
import FlipText from "./FlipText.vue";

defineProps<{
  /** The accessible name of the timeline. */
  label: string;
  message: string | null;
  detail: string | null;
}>();
</script>

<template>
  <section class="timeline" :aria-label="label">
    <slot />
    <div v-if="message || detail">
      <FlipText
        :text="message"
        variant="message"
        class="text-caption text-fg-secondary"
        role="status"
      />
      <FlipText :text="detail" variant="detail" class="text-body-s text-fg-tertiary" />
    </div>
  </section>
</template>

<style scoped>
.timeline {
  /* The card bleeds past the 24px content gutter to an 8px inset. */
  margin-inline: -1rem;
  overflow: hidden;
  /* 24px; the radius scale has no semantic step this size. */
  border-radius: var(--scale-radius-large);
  background: var(--bg-surface-nested);
}
</style>
