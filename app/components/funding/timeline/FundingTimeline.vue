<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { TimelineView } from "../../../funding/timeline/types";
import { lastReached, TIMELINE_INSETS, timelineDrawing } from "./drawing";
import FlipText from "./FlipText.vue";

const props = defineProps<{
  view: TimelineView;
  message: string | null;
  detail: string | null;
}>();

/** How long a line takes to complete before its end milestone turns green. */
const LINE_COMPLETE_MS = 520;

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Milestones reached together turn green one after the other; the first view shows at once.
const shownReached = ref(lastReached(props.view));
const arriving = ref<number | null>(null);
let stepTimer: ReturnType<typeof setTimeout> | null = null;

function stopStepping() {
  if (stepTimer !== null) clearTimeout(stepTimer);
  stepTimer = null;
}

function step() {
  stepTimer = null;
  const target = lastReached(props.view);
  if (shownReached.value >= target) return;
  shownReached.value += 1;
  arriving.value = shownReached.value;
  if (shownReached.value < target) stepTimer = setTimeout(step, LINE_COMPLETE_MS);
}

watch(
  () => lastReached(props.view),
  (target) => {
    if (target > shownReached.value && !reducedMotion()) {
      stepTimer ??= setTimeout(step, LINE_COMPLETE_MS);
      return;
    }
    stopStepping();
    shownReached.value = target;
    arriving.value = null;
  },
);
onBeforeUnmount(stopStepping);

/** Each milestone with the line that leads into it; the first has none. */
const steps = computed(() => {
  const { milestones, lines } = timelineDrawing(props.view, shownReached.value);
  return milestones.map((milestone, index) => ({ milestone, line: lines[index - 1] }));
});
const insets = {
  paddingInlineStart: `${TIMELINE_INSETS.start}px`,
  paddingInlineEnd: `${TIMELINE_INSETS.end}px`,
};
</script>

<template>
  <section class="timeline" aria-label="Top-up progress">
    <ol class="timeline-card" :style="insets">
      <li
        v-for="({ milestone, line }, index) in steps"
        :key="milestone.id"
        class="timeline-step"
        :style="line ? { flexGrow: line.weight } : undefined"
        :aria-hidden="milestone.label === undefined ? 'true' : undefined"
        :aria-current="milestone.current ? 'step' : undefined"
      >
        <span
          v-if="line"
          class="timeline-line"
          :class="[`timeline-line-${line.tone}`, { 'timeline-line-live': line.live }]"
        >
          <span class="timeline-fill" :style="{ width: `${line.fill * 100}%` }" />
        </span>
        <span
          class="timeline-milestone"
          :class="[
            `timeline-milestone-${milestone.size}`,
            {
              'timeline-milestone-complete': milestone.complete,
              'timeline-milestone-arriving': arriving === index,
            },
          ]"
        >
          <span class="timeline-dot">
            <svg
              v-if="milestone.size === 'large'"
              class="timeline-tick"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M6.67 12 10 15.33 17.33 8" pathLength="1" />
            </svg>
          </span>
          <span v-if="milestone.label" class="timeline-label text-label-s font-semibold">
            {{ milestone.label }}
            <span v-if="milestone.complete" class="sr-only">, complete</span>
          </span>
        </span>
      </li>
    </ol>
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

.timeline-card {
  display: flex;
  height: 5rem;
  padding: 1rem 0 0;
  margin: 0;
  border-radius: var(--scale-radius-large);
  background: var(--bg-surface-container);
  list-style: none;
}

/* Each step after the first is its incoming line and its milestone; only the lines stretch, in the
 * designer's proportions. */
.timeline-step {
  display: flex;
  flex: 0 1 auto;
  height: 2rem;
  align-items: center;
}

.timeline-line {
  --timeline-tone: var(--stroke-secondary);
  position: relative;
  min-width: 0;
  height: 3px;
  flex: 1 1 0;
  background: var(--timeline-tone);
  transition: background-color 300ms ease;
}

.timeline-line-complete {
  --timeline-tone: var(--fg-success);
}

.timeline-line-current {
  --timeline-tone: var(--bg-illustration-dark);
}

.timeline-line-delayed {
  --timeline-tone: var(--fg-warning);
}

.timeline-fill {
  position: absolute;
  inset-block: 0;
  left: 0;
  background: var(--fg-success);
  transition: width 600ms ease-out;
}

/* The soft light that moves into the head of the fill while the phase is live. */
.timeline-line-live .timeline-fill::after {
  position: absolute;
  top: 50%;
  right: -0.375rem;
  width: 0.75rem;
  height: 0.75rem;
  margin-top: -0.375rem;
  border-radius: 9999px;
  background: radial-gradient(closest-side, var(--timeline-tone), transparent);
  animation: timeline-head 1.6s ease-in-out infinite;
  content: "";
}

@keyframes timeline-head {
  0% {
    opacity: 0;
    transform: translateX(-0.75rem) scale(0.6);
  }
  50% {
    opacity: 0.9;
  }
  100% {
    opacity: 0;
    transform: translateX(0) scale(1);
  }
}

.timeline-milestone {
  position: relative;
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
}

.timeline-milestone-large {
  width: 2rem;
  height: 2rem;
}

.timeline-milestone-small {
  width: 1rem;
  height: 1rem;
}

.timeline-dot {
  display: flex;
  border-radius: 9999px;
  background: var(--stroke-secondary);
  transition: background-color 300ms ease;
}

.timeline-milestone-large .timeline-dot {
  width: 1.5rem;
  height: 1.5rem;
  background: var(--bg-surface-nested);
  color: var(--fg-secondary);
}

.timeline-milestone-small .timeline-dot {
  width: 0.75rem;
  height: 0.75rem;
}

.timeline-milestone-complete .timeline-dot {
  background: var(--fg-success);
  color: var(--fg-primary);
}

.timeline-tick {
  width: 100%;
  height: 100%;
  fill: none;
  stroke: currentColor;
  stroke-dasharray: 1 1;
  stroke-dashoffset: 0;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.5;
}

.timeline-label {
  position: absolute;
  top: calc(100% + 1px);
  left: 50%;
  color: var(--fg-tertiary);
  translate: -50%;
  white-space: nowrap;
  transition: color 300ms ease;
}

.timeline-milestone-complete .timeline-label {
  color: var(--fg-success);
}

.timeline-milestone-arriving .timeline-dot {
  animation: timeline-bump 360ms cubic-bezier(0.3, 0.7, 0.4, 1);
}

.timeline-milestone-arriving .timeline-tick {
  animation: timeline-tick 340ms cubic-bezier(0.2, 0.8, 0.2, 1) 120ms backwards;
}

@keyframes timeline-bump {
  50% {
    transform: scale(1.3);
  }
}

@keyframes timeline-tick {
  from {
    stroke-dashoffset: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .timeline-fill {
    transition: none;
  }

  .timeline-line-live .timeline-fill::after {
    display: none;
  }
}
</style>
