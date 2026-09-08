<script setup lang="ts">
import { computed } from "vue";
import type { FundingProgressProjection } from "../../../funding/progress";

const props = withDefaults(
  defineProps<{
    progress: FundingProgressProjection;
    header?: boolean;
    live?: boolean;
  }>(),
  {
    header: true,
    live: false,
  },
);

const width = computed(() => `${props.progress.view.value * 100}%`);
</script>

<template>
  <div class="funding-progress-bar" :class="`funding-progress-bar-${progress.view.kind}`">
    <div
      v-if="header"
      class="funding-progress-bar-header"
      :aria-live="live ? 'polite' : undefined"
      aria-atomic="true"
    >
      <span class="funding-progress-bar-label">{{ progress.view.label }}</span>
      <span class="funding-progress-bar-estimate">{{ progress.estimateText }}</span>
    </div>
    <div
      class="funding-progress-bar-track"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="progress.view.valueNow"
      :aria-valuetext="progress.view.valueText"
    >
      <span class="funding-progress-bar-fill" :style="{ width }" />
    </div>
  </div>
</template>

<style scoped>
.funding-progress-bar {
  --progress-bar-fill: var(--color-progress);
  width: 100%;
}

.funding-progress-bar-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.5625rem;
}

.funding-progress-bar-label {
  min-width: 0;
  overflow: hidden;
  color: var(--funding-text, var(--color-text-primary));
  font-size: 0.84375rem;
  line-height: 1.125rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.funding-progress-bar-estimate {
  flex: none;
  color: var(--funding-text-muted, var(--color-text-secondary));
  font-size: 0.71875rem;
  line-height: 1rem;
  white-space: nowrap;
}

.funding-progress-bar-track {
  height: 0.25rem;
  overflow: hidden;
  border-radius: 9999px;
  background: color-mix(
    in srgb,
    var(--funding-border, var(--color-stroke-secondary)) 35%,
    transparent
  );
}

.funding-progress-bar-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--progress-bar-fill);
  transition: width 400ms ease;
}

.funding-progress-bar-waiting {
  --progress-bar-fill: var(--funding-border, var(--color-stroke-secondary));
}

.funding-progress-bar-failed {
  --progress-bar-fill: var(--funding-error, var(--color-error));
}

.funding-progress-bar-settled {
  --progress-bar-fill: var(--funding-success, var(--color-success));
}

@media (prefers-reduced-motion: reduce) {
  .funding-progress-bar-fill {
    transition: none;
  }
}
</style>
