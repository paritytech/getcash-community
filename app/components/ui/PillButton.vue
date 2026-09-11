<script setup lang="ts">
// The pill CTA: primary carries the screen's one main action, tertiary the quiet exits (Back,
// Close). Layout (width, margins) belongs to the call site.
withDefaults(defineProps<{ variant?: "primary" | "tertiary" }>(), { variant: "primary" });
</script>

<template>
  <button
    type="button"
    class="h-12 shrink-0 rounded-full text-label-l font-semibold transition-colors"
    :class="
      variant === 'primary'
        ? 'bg-action-primary text-fg-primary-inverted hover:bg-action-primary-hover disabled:bg-action-disabled disabled:text-fg-disabled'
        : 'bg-action-tertiary text-fg-primary hover:bg-action-tertiary-hover'
    "
  >
    <slot />
  </button>
</template>
