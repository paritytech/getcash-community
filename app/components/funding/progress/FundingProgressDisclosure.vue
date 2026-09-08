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
          <strong>{{ progress.view.label }}</strong>
          <span>{{ progress.estimateText }}</span>
        </div>
        <FundingProgressBar :progress="progress" :header="false" />
        <p v-if="message && messageTone === 'error'" class="funding-progress-message is-error">
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
            <span v-if="node.state === 'complete'">✓</span>
          </span>
          <span v-if="index < progress.view.nodes.length - 1" class="funding-progress-step-line" />
        </span>
        <span class="funding-progress-step-copy">
          <strong>{{ nodeTitle(node) }}</strong>
          <span v-if="nodeDetail(node)">{{ nodeDetail(node) }}</span>
        </span>
      </li>
    </ol>

    <p
      v-if="message && messageTone !== 'error'"
      class="funding-progress-message"
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
  font-size: 0.8125rem;
  line-height: 1.125rem;
  font-weight: 550;
}

.funding-progress-summary-copy span {
  flex: none;
  color: var(--funding-text-muted, var(--color-text-secondary));
  font-size: 0.6875rem;
  line-height: 1rem;
}

.funding-progress-steps {
  display: flex;
  flex-direction: column;
}

.funding-progress-step {
  --progress-step-color: var(--funding-border, var(--color-stroke-secondary));
  display: grid;
  min-height: 3.25rem;
  grid-template-columns: 1.25rem minmax(0, 1fr);
  gap: 0.75rem;
}

.funding-progress-step-complete {
  --progress-step-color: var(--funding-success, var(--color-success));
}

.funding-progress-step-current {
  --progress-step-color: var(--color-progress);
}

.funding-progress-steps-failed .funding-progress-step-current {
  --progress-step-color: var(--funding-error, var(--color-error));
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
  background: var(--funding-surface, var(--color-surface-container));
  color: var(--funding-background, var(--color-bg));
  font-size: 0.6875rem;
  font-weight: 800;
}

.funding-progress-step-complete .funding-progress-step-marker,
.funding-progress-step-current .funding-progress-step-marker {
  background: var(--progress-step-color);
}

.funding-progress-step-current .funding-progress-step-marker {
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--progress-step-color) 14%, transparent);
  animation: funding-progress-pulse 1.8s ease-in-out infinite;
}

.funding-progress-step-line {
  width: 1.5px;
  min-height: 1.5rem;
  flex: 1;
  background: color-mix(in srgb, var(--progress-step-color) 50%, transparent);
}

.funding-progress-step-current .funding-progress-step-line {
  background: color-mix(
    in srgb,
    var(--funding-border, var(--color-stroke-secondary)) 50%,
    transparent
  );
}

.funding-progress-step-copy {
  display: flex;
  min-width: 0;
  padding-bottom: 0.875rem;
  flex-direction: column;
}

.funding-progress-step-copy strong {
  color: var(--funding-text-muted, var(--color-text-secondary));
  font-size: 0.875rem;
  line-height: 1.125rem;
  font-weight: 550;
}

.funding-progress-step-complete .funding-progress-step-copy strong {
  color: var(--funding-success, var(--color-success));
}

.funding-progress-step-current .funding-progress-step-copy strong {
  color: var(--funding-text, var(--color-text-primary));
}

.funding-progress-step-copy span {
  margin-top: 0.1875rem;
  color: var(--funding-text-muted, var(--color-text-secondary));
  font-size: 0.75rem;
  line-height: 1rem;
}

.funding-progress-message {
  margin-top: 0.75rem;
  color: var(--funding-text-muted, var(--color-text-secondary));
  font-size: 0.8125rem;
  line-height: 1.125rem;
}

.funding-progress-message.is-notice {
  color: var(--color-progress);
}

.funding-progress-message.is-error {
  color: var(--funding-error, var(--color-error));
}

@keyframes funding-progress-pulse {
  50% {
    box-shadow: 0 0 0 6px color-mix(in srgb, var(--progress-step-color) 8%, transparent);
  }
}

@media (prefers-reduced-motion: reduce) {
  .funding-progress-step-current .funding-progress-step-marker {
    animation: none;
  }
}
</style>
