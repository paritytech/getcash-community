<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { lastReached } from "../../../funding/timeline/model";
import type { TimelineView } from "../../../funding/timeline/types";
import { TIMELINE_INSETS, timelineDrawing } from "./drawing";
import TimelineBand from "./TimelineBand.vue";

const props = defineProps<{
  view: TimelineView;
  message: string | null;
  detail: string | null;
}>();
const emit = defineEmits<{
  /** The drawing completed Added on a top-up that is done. */
  added: [];
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
watch(shownReached, (reached) => {
  if (props.view.state === "done" && reached === lastReached(props.view)) emit("added");
});

// A failure that arrives on screen plays its motion; one present when the screen opens shows at once.
const failing = ref(false);
watch(
  () => props.view.state === "failed",
  (failed) => {
    failing.value = failed && !reducedMotion();
  },
);

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
  <TimelineBand :message="message" :detail="detail" :class="{ 'timeline-failing': failing }">
    <ol class="timeline-card" :style="insets">
      <li
        v-for="({ milestone, line }, index) in steps"
        :key="milestone.id"
        class="timeline-step"
        :style="line ? { flexGrow: line.weight } : undefined"
        :aria-hidden="milestone.label === undefined ? 'true' : undefined"
        :aria-current="milestone.current ? 'step' : undefined"
      >
        <span v-if="line" class="timeline-line" :class="`timeline-line-${line.tone}`">
          <span class="timeline-fill" :style="{ width: `${line.fill * 100}%` }" />
        </span>
        <span
          class="timeline-milestone"
          :class="[
            `timeline-milestone-${milestone.size}`,
            {
              'timeline-milestone-complete': milestone.state === 'complete',
              'timeline-milestone-failed': milestone.state === 'failed',
              'timeline-milestone-arriving': arriving === index,
            },
            milestone.halo && `timeline-milestone-next timeline-halo-${milestone.halo}`,
          ]"
        >
          <span v-if="milestone.halo" class="timeline-halo" aria-hidden="true" />
          <span class="timeline-dot">
            <svg
              v-if="milestone.state === 'failed'"
              class="timeline-glyph timeline-cross"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M8.5 8.5 15.5 15.5M15.5 8.5 8.5 15.5" />
            </svg>
            <svg
              v-else-if="milestone.size === 'large'"
              class="timeline-glyph timeline-tick"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M6.67 12 10 15.33 17.33 8" pathLength="1" />
            </svg>
          </span>
          <span
            v-if="milestone.label"
            class="timeline-label text-label-s font-semibold"
            :class="`timeline-label-${milestone.labelAlign}`"
          >
            {{ milestone.label }}
            <span v-if="milestone.state === 'complete'" class="sr-only">, complete</span>
          </span>
        </span>
      </li>
    </ol>
  </TimelineBand>
</template>

<style scoped>
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

.timeline-line-current,
.timeline-halo-current {
  --timeline-tone: var(--bg-illustration-dark);
}

.timeline-line-delayed,
.timeline-halo-delayed {
  --timeline-tone: var(--fg-warning);
}

.timeline-line-failed {
  --timeline-tone: var(--fg-error);
}

.timeline-fill {
  position: absolute;
  inset-block: 0;
  left: 0;
  background: var(--fg-success);
  transition: width 600ms ease-out;
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
  position: relative;
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

.timeline-milestone-failed .timeline-dot {
  background: var(--fg-error);
  color: var(--fg-primary);
}

/* The next milestone is painted in its line's tone, with a ripple behind the dot at its size. */
.timeline-milestone-next .timeline-dot {
  background: var(--timeline-tone);
}

.timeline-halo {
  position: absolute;
  inset: 12.5%;
  border-radius: 9999px;
  background: var(--timeline-tone);
  animation: timeline-ripple 1.6s cubic-bezier(0.2, 0.6, 0.3, 1) infinite;
  pointer-events: none;
}

@keyframes timeline-ripple {
  from {
    opacity: 0.5;
  }
  to {
    opacity: 0;
    transform: scale(2.1);
  }
}

.timeline-glyph {
  width: 100%;
  height: 100%;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.5;
}

.timeline-tick {
  stroke-dasharray: 1 1;
  stroke-dashoffset: 0;
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

/* A grown failed milestone's label leans away from its nearer labelled neighbour. */
.timeline-label-start {
  left: 50%;
  translate: none;
}

.timeline-label-end {
  right: 50%;
  left: auto;
  translate: none;
}

.timeline-milestone-complete .timeline-label {
  color: var(--fg-success);
}

.timeline-milestone-failed .timeline-label {
  color: var(--fg-error);
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

/* A failure: the milestone grows, then its cross and label fade in, then one soft bump. */
.timeline-failing .timeline-milestone,
.timeline-failing .timeline-dot {
  transition:
    width 380ms ease-out,
    height 380ms ease-out,
    background-color 300ms ease;
}

.timeline-failing .timeline-milestone-failed :is(.timeline-cross, .timeline-label) {
  animation: timeline-fade 250ms ease-out 380ms backwards;
}

.timeline-failing .timeline-milestone-failed .timeline-dot {
  animation: timeline-failed-bump 520ms cubic-bezier(0.3, 0.7, 0.4, 1) 630ms;
}

@keyframes timeline-fade {
  from {
    opacity: 0;
  }
}

@keyframes timeline-failed-bump {
  50% {
    transform: scale(1.12);
  }
}

@media (prefers-reduced-motion: reduce) {
  .timeline-fill {
    transition: none;
  }

  .timeline-halo {
    display: none;
  }
}
</style>
