<script setup lang="ts">
// A screen inside the shell: its content, and under it the actions, pinned 32px over the safe
// area. The content keeps its own scrolling where it has any.
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col">
    <div class="flex min-h-0 flex-1 flex-col">
      <slot />
    </div>
    <div v-if="$slots.actions" class="flex shrink-0 flex-col pb-cta">
      <slot name="actions" />
    </div>
  </section>
</template>
