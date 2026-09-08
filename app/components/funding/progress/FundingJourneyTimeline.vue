<script setup lang="ts">
import { computed } from "vue";
import {
  formatFundingProgressElapsed,
  type FundingProgressProjection,
} from "../../../funding/progress";

const props = withDefaults(
  defineProps<{
    progress: FundingProgressProjection;
    completedSteps: number;
    message?: string | null;
    messageTone?: "muted" | "notice" | "error";
  }>(),
  {
    message: null,
    messageTone: "muted",
  },
);

const stages = [
  { label: "Payment detected", activeLabel: "Detecting your payment" },
  { label: "Payment confirmed", activeLabel: "Confirming your payment" },
  { label: "Payment processed", activeLabel: "Processing your payment" },
  { label: "Converting to CASH", activeLabel: "Converting to CASH" },
  { label: "CASH credited", activeLabel: "Crediting CASH" },
] as const;

const settled = computed(() => props.progress.view.kind === "settled");
const failed = computed(() => props.progress.view.kind === "failed");
/** Completed dots. A failure before any payment was detected stops on the first dot with nothing
 *  complete. */
const completed = computed(() => {
  if (failed.value && props.progress.detectedAt === undefined) return 0;
  return Math.max(props.completedSteps, 0);
});
const activeIndex = computed(() =>
  settled.value ? -1 : Math.min(completed.value, stages.length - 1),
);

function stageState(index: number): "complete" | "current" | "upcoming" {
  if (settled.value || index < completed.value) return "complete";
  if (index === activeIndex.value) return "current";
  return "upcoming";
}

const statusTitle = computed(() => {
  if (settled.value) return "CASH credited";
  // On failure the reason takes the title.
  if (failed.value && props.message && props.messageTone === "error") return props.message;
  return stages[activeIndex.value]?.activeLabel ?? stages[0].activeLabel;
});

const statusDetail = computed(() => {
  if (settled.value) return "Complete";
  const elapsed = formatFundingProgressElapsed(props.progress.view.stageElapsedMs);
  if (props.progress.view.kind === "failed") {
    return elapsed === "just now" ? "Stopped just now" : `Stopped after ${elapsed}`;
  }
  return elapsed === "just now" ? "Started just now" : `Started ${elapsed} ago`;
});
</script>

<template>
  <section
    class="funding-journey"
    :class="`funding-journey-${progress.view.kind}`"
    :aria-labelledby="settled ? undefined : 'funding-journey-status'"
    :aria-label="settled ? 'Top-up complete' : undefined"
  >
    <ol class="funding-journey-steps" aria-label="Top-up progress">
      <li
        v-for="(stage, index) in stages"
        :key="stage.label"
        class="funding-journey-step"
        :class="`funding-journey-step-${stageState(index)}`"
        :aria-current="stageState(index) === 'current' ? 'step' : undefined"
      >
        <span class="funding-journey-marker" aria-hidden="true" />
        <span class="funding-journey-label text-overline">{{ stage.label }}</span>
      </li>
    </ol>

    <div
      v-if="!settled"
      id="funding-journey-status"
      class="funding-journey-status"
      aria-live="polite"
    >
      <strong class="text-heading-l text-fg-primary">{{ statusTitle }}</strong>
      <span class="text-caption text-fg-secondary">{{ statusDetail }}</span>
    </div>
    <!-- hidden, not needed for now -->
    <!--
    <p
      v-if="message"
      class="funding-journey-message text-caption"
      :class="`funding-journey-message-${messageTone}`"
    >
      {{ message }}
    </p>
    -->
  </section>
</template>

<style scoped>
.funding-journey {
  /* State is semantic: completed steps are the success surface, the active step is
   * the strongest stroke step (the scale's step-indicator colour), failure is the
   * error surface. The old mint accent had no token — reported as a gap. */
  --journey-complete: var(--bg-status-success);
  --journey-current: var(--stroke-tertiary);
  --journey-upcoming: var(--stroke-secondary);
  width: 100%;
}

.funding-journey-failed {
  --journey-current: var(--bg-status-error);
}

.funding-journey-steps {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  width: 100%;
  padding: 0;
  list-style: none;
}

.funding-journey-step {
  position: relative;
  min-width: 0;
  text-align: center;
}

.funding-journey-step::after {
  position: absolute;
  z-index: 0;
  top: 0.4375rem;
  left: 50%;
  width: 100%;
  height: 2px;
  background: var(--journey-upcoming);
  content: "";
}

.funding-journey-step:last-child::after {
  display: none;
}

.funding-journey-step-complete::after {
  background: var(--journey-complete);
}

.funding-journey-marker {
  position: relative;
  z-index: 1;
  display: block;
  width: 0.9375rem;
  height: 0.9375rem;
  margin-inline: auto;
  border: 2px solid var(--journey-upcoming);
  border-radius: 9999px;
  background: var(--bg-surface-main);
}

.funding-journey-step-complete .funding-journey-marker {
  border-color: var(--journey-complete);
  background: var(--journey-complete);
}

.funding-journey-step-current .funding-journey-marker {
  /* Activity is a gentle scale pulse; the old tinted halo was a coloured
   * box-shadow, which the design system rules out. */
  border-color: var(--journey-current);
  background: var(--journey-current);
  animation: funding-journey-pulse 1.8s ease-in-out infinite;
}

.funding-journey-label {
  display: block;
  margin-top: 0.75rem;
  padding-inline: 0.125rem;
  color: var(--fg-secondary);
  overflow-wrap: anywhere;
}

.funding-journey-step-complete .funding-journey-label {
  color: var(--fg-success);
}

.funding-journey-step-current .funding-journey-label {
  color: var(--fg-secondary);
}

.funding-journey-failed .funding-journey-step-current .funding-journey-label {
  color: var(--fg-error);
}

.funding-journey-status {
  display: flex;
  margin-top: 1.75rem;
  flex-direction: column;
  align-items: center;
  gap: 0.125rem;
  text-align: center;
}

.funding-journey-message {
  margin-top: 0.75rem;
  color: var(--fg-secondary);
  text-align: center;
}

.funding-journey-message-notice {
  color: var(--fg-secondary);
}

.funding-journey-message-error {
  color: var(--fg-error);
}

@keyframes funding-journey-pulse {
  50% {
    transform: scale(1.15);
  }
}

@media (prefers-reduced-motion: reduce) {
  .funding-journey-step-current .funding-journey-marker {
    animation: none;
  }
}
</style>
