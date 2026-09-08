<script setup lang="ts">
import { computed } from "vue";
import { formatFundingHistoryWhen } from "../../../funding/history";
import {
  formatFundingProgressElapsed,
  type FundingProgressNodeView,
  type FundingProgressProjection,
} from "../../../funding/progress";
import FundingDisclosure from "../FundingDisclosure.vue";
import FundingProgressBar from "./FundingProgressBar.vue";
import { Check } from "lucide-vue-next";

const props = withDefaults(
  defineProps<{
    progress: FundingProgressProjection;
    message?: string | null;
    messageTone?: "muted" | "notice" | "error";
  }>(),
  {
    message: null,
    messageTone: "muted",
  },
);

const activeIndex = computed(() => props.progress.view.activeNodeIndex);

function nodeTitle(node: FundingProgressNodeView): string {
  return node.state === "current" ? props.progress.view.label : node.label;
}

function nodeDetail(node: FundingProgressNodeView): string | null {
  if (node.state === "upcoming") return null;
  if (node.state === "current") {
    if (props.progress.view.kind === "waiting") return "Waiting to be detected";
    const elapsed = formatFundingProgressElapsed(props.progress.view.stageElapsedMs);
    return props.progress.view.kind === "failed"
      ? `Stopped after ${elapsed}`
      : `Started ${elapsed} ago`;
  }
  const timestamp =
    node.key === props.progress.view.nodes.at(-1)?.key
      ? props.progress.settledAt
      : props.progress.stageTimestamps[node.key];
  return timestamp === undefined ? "Completed" : formatFundingHistoryWhen(timestamp);
}
</script>

<template>
  <FundingDisclosure title="Progress">
    <template #summary>
      <div class="funding-progress-summary" aria-live="polite" aria-atomic="true">
        <div class="funding-progress-summary-copy">
          <strong class="text-heading-s">{{ progress.view.label }}</strong>
          <span class="text-caption">{{ progress.estimateText }}</span>
        </div>
        <FundingProgressBar :progress="progress" :header="false" />
        <p v-if="message && messageTone === 'error'" class="funding-progress-message text-caption is-error">
          {{ message }}
        </p>
      </div>
    </template>

    <ol class="funding-progress-steps" :class="`funding-progress-steps-${progress.view.kind}`">
      <li
        v-for="(node, index) in progress.view.nodes"
        :key="node.key"
        class="funding-progress-step"
        :class="`funding-progress-step-${node.state}`"
        :aria-current="index === activeIndex ? 'step' : undefined"
      >
        <span class="funding-progress-step-rail" aria-hidden="true">
          <span class="funding-progress-step-marker">
            <Check v-if="node.state === 'complete'" class="size-2.5" :stroke-width="4" aria-hidden="true" />
          </span>
          <span v-if="index < progress.view.nodes.length - 1" class="funding-progress-step-line" />
        </span>
        <span class="funding-progress-step-copy">
          <strong class="text-heading-s">{{ nodeTitle(node) }}</strong>
          <span v-if="nodeDetail(node)" class="text-caption">{{ nodeDetail(node) }}</span>
        </span>
      </li>
    </ol>

    <p
      v-if="message && messageTone !== 'error'"
      class="funding-progress-message text-caption"
      :class="{ 'is-notice': messageTone === 'notice' }"
    >
      {{ message }}
    </p>
  </FundingDisclosure>
</template>

<style scoped>
.funding-progress-summary {
  width: 100%;
  margin-top: 0.75rem;
}

.funding-progress-summary-copy {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.625rem;
}

.funding-progress-summary-copy strong {
  min-width: 0;
}

.funding-progress-summary-copy span {
  flex: none;
  color: var(--fg-secondary);
}

.funding-progress-steps {
  display: flex;
  flex-direction: column;
}

.funding-progress-step {
  --progress-step-color: var(--stroke-secondary);
  display: grid;
  min-height: 3.25rem;
  grid-template-columns: 1.25rem minmax(0, 1fr);
  gap: 0.75rem;
}

.funding-progress-step-complete {
  --progress-step-color: var(--bg-status-success);
}

.funding-progress-step-current {
  /* In-progress accent: the strongest stroke step, the scale's step-indicator colour. */
  --progress-step-color: var(--stroke-tertiary);
}

.funding-progress-steps-failed .funding-progress-step-current {
  --progress-step-color: var(--bg-status-error);
}

.funding-progress-step-rail {
  display: flex;
  height: 100%;
  align-items: center;
  flex-direction: column;
}

.funding-progress-step-marker {
  display: flex;
  width: 1rem;
  height: 1rem;
  flex: none;
  align-items: center;
  justify-content: center;
  border: 1.5px solid var(--progress-step-color);
  border-radius: 9999px;
  background: var(--bg-surface-container);
  color: var(--bg-surface-main);
}

.funding-progress-step-complete .funding-progress-step-marker,
.funding-progress-step-current .funding-progress-step-marker {
  background: var(--progress-step-color);
}

.funding-progress-step-current .funding-progress-step-marker {
/* Activity is a gentle scale pulse; the old tinted halo was a coloured
   * box-shadow, which the design system rules out. */
  animation: funding-progress-pulse 1.8s ease-in-out infinite;
}

.funding-progress-step-line {
  width: 1.5px;
  min-height: 1.5rem;
  flex: 1;
  background: color-mix(in srgb, var(--progress-step-color) 50%, transparent);
}

.funding-progress-step-current .funding-progress-step-line {
  background: var(--stroke-secondary);
}

.funding-progress-step-copy {
  display: flex;
  min-width: 0;
  padding-bottom: 0.875rem;
  flex-direction: column;
}

.funding-progress-step-copy strong {
  color: var(--fg-secondary);
}

.funding-progress-step-complete .funding-progress-step-copy strong {
  color: var(--fg-success);
}

.funding-progress-step-current .funding-progress-step-copy strong {
  color: var(--fg-primary);
}

.funding-progress-step-copy span {
  margin-top: 0.1875rem;
  color: var(--fg-secondary);
}

.funding-progress-message {
  margin-top: 0.75rem;
  color: var(--fg-secondary);
}

.funding-progress-message.is-notice {
  color: var(--fg-secondary);
}

.funding-progress-message.is-error {
  color: var(--fg-error);
}

@keyframes funding-progress-pulse {
  50% {
    transform: scale(1.15);
  }
}

@media (prefers-reduced-motion: reduce) {
  .funding-progress-step-current .funding-progress-step-marker {
    animation: none;
  }
}
</style>
