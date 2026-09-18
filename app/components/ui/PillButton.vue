<script setup lang="ts">
// The pill CTA: primary carries the screen's one main action, secondary a recovery from a state
// that is not the buyer's fault (Retry quote), tertiary the quiet exits (Back, Close), danger the
// one that undoes a top-up (Cancel). Layout (width, margins) belongs to the call site.
withDefaults(defineProps<{ variant?: "primary" | "secondary" | "tertiary" | "danger" }>(), {
  variant: "primary",
});
</script>

<template>
  <button
    type="button"
    class="h-12 shrink-0 rounded-full text-label-l font-semibold transition-colors"
    :class="{
      'bg-action-primary text-fg-primary-inverted hover:bg-action-primary-hover disabled:bg-action-disabled disabled:text-fg-disabled':
        variant === 'primary',
      'bg-action-secondary text-fg-primary hover:bg-action-secondary-hover':
        variant === 'secondary',
      'bg-action-tertiary text-fg-primary hover:bg-action-tertiary-hover': variant === 'tertiary',
      'bg-status-error text-fg-static-white hover:bg-status-error-hover disabled:opacity-50':
        variant === 'danger',
    }"
  >
    <slot />
  </button>
</template>
