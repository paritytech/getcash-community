<script setup lang="ts">
import { computed } from "vue";
import type { FundingProgressProjection } from "../../../funding/progress";

const props = withDefaults(
  defineProps<{
    progress: FundingProgressProjection;
    size?: number;
  }>(),
  { size: 30 },
);

const stroke = 2.6;
const radius = computed(() => (props.size - stroke) / 2);
const circumference = computed(() => 2 * Math.PI * radius.value);
const offset = computed(() => circumference.value * (1 - props.progress.view.value));
</script>

<template>
  <svg
    class="funding-progress-ring"
    :class="`funding-progress-ring-${progress.view.kind}`"
    :width="size"
    :height="size"
    :viewBox="`0 0 ${size} ${size}`"
    aria-hidden="true"
    focusable="false"
  >
    <circle
      class="funding-progress-ring-track"
      :cx="size / 2"
      :cy="size / 2"
      :r="radius"
      :stroke-width="stroke"
    />
    <circle
      class="funding-progress-ring-fill"
      :cx="size / 2"
      :cy="size / 2"
      :r="radius"
      :stroke-width="stroke"
      :stroke-dasharray="circumference"
      :stroke-dashoffset="offset"
      :transform="`rotate(-90 ${size / 2} ${size / 2})`"
    />
    <path
      v-if="progress.view.kind === 'settled'"
      class="funding-progress-ring-tick"
      :d="`M${size * 0.31} ${size * 0.52} L${size * 0.44} ${size * 0.65} L${size * 0.69} ${size * 0.36}`"
    />
  </svg>
</template>

<style scoped>
.funding-progress-ring {
  --progress-ring-fill: var(--color-progress);
  display: block;
  flex: none;
  overflow: visible;
}

.funding-progress-ring circle {
  fill: none;
}

.funding-progress-ring-track {
  stroke: color-mix(in srgb, var(--funding-border, var(--color-stroke-secondary)) 45%, transparent);
}

.funding-progress-ring-fill {
  stroke: var(--progress-ring-fill);
  stroke-linecap: round;
  transition: stroke-dashoffset 400ms ease;
}

.funding-progress-ring-waiting {
  --progress-ring-fill: var(--funding-border, var(--color-stroke-secondary));
}

.funding-progress-ring-failed {
  --progress-ring-fill: var(--funding-error, var(--color-error));
}

.funding-progress-ring-settled {
  --progress-ring-fill: var(--funding-success, var(--color-success));
}

.funding-progress-ring-tick {
  fill: none;
  stroke: var(--progress-ring-fill);
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2.2;
}

@media (prefers-reduced-motion: reduce) {
  .funding-progress-ring-fill {
    transition: none;
  }
}
</style>
