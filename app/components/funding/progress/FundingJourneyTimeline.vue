<script setup lang="ts">
import { computed } from "vue";
import { Check, LoaderCircle, X } from "lucide-vue-next";
import type { FundingProgressProjection } from "../../../funding/progress";

const props = withDefaults(
  defineProps<{
    progress: FundingProgressProjection;
    completedSteps: number;
    /** The one line under the stepper: the ribbon only shows when there is something to say. */
    message?: string | null;
  }>(),
  {
    message: null,
  },
);

const stages = ["Started", "Payment", "Approved", "Conversion", "Added"] as const;

const settled = computed(() => props.progress.view.kind === "settled");
const failed = computed(() => props.progress.view.kind === "failed");
/** Completed markers. A failure before any payment was detected stops on the first marker with
 *  nothing complete. */
const completed = computed(() => {
  if (failed.value && props.progress.detectedAt === undefined) return 0;
  return Math.max(props.completedSteps, 0);
});
const activeIndex = computed(() =>
  settled.value ? -1 : Math.min(completed.value, stages.length - 1),
);

type StepState = "complete" | "current" | "failed" | "upcoming";
function stageState(index: number): StepState {
  if (settled.value || index < completed.value) return "complete";
  if (index === activeIndex.value) return failed.value ? "failed" : "current";
  return "upcoming";
}

function stageLabel(index: number): string {
  const label = stages[index]!;
  return stageState(index) === "failed" ? `${label} failed` : label;
}
</script>

<template>
  <section class="funding-journey" aria-label="Top-up progress">
    <div class="funding-journey-card">
      <ol class="funding-journey-steps">
        <!-- Connectors run centre to centre behind the markers; each takes the colour of the
             step it leads to. The marker's outer ring is the card surface, masking the line. -->
        <span
          v-for="index in stages.length - 1"
          :key="`connector-${index}`"
          class="funding-journey-connector"
          :class="`funding-journey-connector-${stageState(index)}`"
          :style="{ left: `calc(1rem + ${index - 1} * (100% - 2rem) / 4)` }"
          aria-hidden="true"
        />
        <li
          v-for="(stage, index) in stages"
          :key="stage"
          class="funding-journey-step"
          :class="`funding-journey-step-${stageState(index)}`"
          :aria-current="stageState(index) === 'current' ? 'step' : undefined"
        >
          <span class="funding-journey-marker" aria-hidden="true">
            <LoaderCircle
              v-if="stageState(index) === 'current'"
              class="funding-journey-spinner size-4"
              :stroke-width="1.5"
            />
            <X v-else-if="stageState(index) === 'failed'" class="size-4" :stroke-width="1.5" />
            <Check v-else class="size-4" :stroke-width="1.5" />
          </span>
          <span class="funding-journey-label text-label-xs">{{ stageLabel(index) }}</span>
        </li>
      </ol>
    </div>
    <div v-if="message" class="funding-journey-ribbon" aria-live="polite">
      <p class="text-body-s text-fg-secondary">{{ message }}</p>
    </div>
  </section>
</template>

<style scoped>
.funding-journey {
  position: relative;
  /* The card bleeds past the 24px content gutter to an 8px inset. */
  margin-inline: -1rem;
}

.funding-journey-card {
  position: relative;
  z-index: 1;
  height: 5rem;
  padding: 1rem 1.5rem 0;
  /* 24px; the radius scale has no semantic step this size. */
  border-radius: var(--scale-radius-large);
  background: var(--bg-surface-container);
}

.funding-journey-steps {
  position: relative;
  display: flex;
  justify-content: space-between;
  padding: 0;
  list-style: none;
}

.funding-journey-connector {
  position: absolute;
  top: calc(1rem - 1.5px);
  width: calc((100% - 2rem) / 4);
  height: 3px;
  background: var(--stroke-secondary);
}

.funding-journey-connector-complete {
  background: var(--fg-success);
}

.funding-journey-connector-current {
  background: var(--bg-illustration-dark);
}

.funding-journey-connector-failed {
  background: var(--bg-status-error);
}

.funding-journey-step {
  position: relative;
  z-index: 1;
  width: 2rem;
}

.funding-journey-marker {
  display: flex;
  width: 2rem;
  height: 2rem;
  align-items: center;
  justify-content: center;
  border: 4px solid var(--bg-surface-container);
  border-radius: 9999px;
  background: var(--stroke-secondary);
  color: var(--fg-secondary);
}

.funding-journey-step-complete .funding-journey-marker {
  background: var(--fg-success);
  color: var(--fg-primary);
}

.funding-journey-step-current .funding-journey-marker {
  background: var(--bg-illustration-dark);
  color: var(--bg-surface-main);
}

.funding-journey-step-failed .funding-journey-marker {
  background: var(--bg-status-error);
  color: var(--fg-primary);
}

.funding-journey-label {
  position: absolute;
  top: calc(100% + 0.25rem);
  left: 50%;
  translate: -50%;
  color: var(--fg-tertiary);
  white-space: nowrap;
}

.funding-journey-step-complete .funding-journey-label {
  color: var(--fg-success);
}

.funding-journey-step-current .funding-journey-label {
  color: var(--fg-primary);
}

.funding-journey-step-failed .funding-journey-label {
  color: var(--fg-error);
}

/* The ribbon sits behind the card and extends 32px below it; the message is centred in the
 * exposed strip. */
.funding-journey-ribbon {
  position: relative;
  display: flex;
  height: 5rem;
  margin-top: -3rem;
  align-items: flex-end;
  justify-content: center;
  border-bottom-right-radius: var(--scale-radius-large);
  border-bottom-left-radius: var(--scale-radius-large);
  background: var(--bg-surface-nested);
  text-align: center;
}

.funding-journey-ribbon p {
  display: flex;
  height: 2rem;
  align-items: center;
  padding-inline: 1rem;
}

.funding-journey-spinner {
  animation: funding-journey-spin 1.2s linear infinite;
}

@keyframes funding-journey-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .funding-journey-spinner {
    animation: none;
  }
}
</style>
