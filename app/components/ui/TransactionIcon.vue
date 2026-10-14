<script setup lang="ts">
// Pocket's transaction icon for money coming in: an up-right arrow tucked into the corner of a
// card, on a light circle. Played, the arrow arrives spinning, tucks into the corner while the card
// draws around it, then the dot pops in.
import { onMounted, ref } from "vue";

const props = withDefaults(
  defineProps<{
    /** Plays the morph once on mount, rather than drawing the end state. */
    animate?: boolean;
    /** How long the morph waits before the arrow arrives, in ms. */
    delay?: number;
  }>(),
  { animate: false, delay: 0 },
);

const STROKE = 2;
// The arrow's move into the card's corner, from Pocket's icon source.
const TUCK = { x: 6.0599, y: 19.0602, scale: 0.42426 };
const TUCK_STEPS = 16;

/** The arrow `progress` of the way into the corner, its stroke kept at 2 as it shrinks. */
const tucked = (progress: number) => {
  const scale = 1 + (TUCK.scale - 1) * progress;
  return {
    transform: `translate(${TUCK.x * progress}px, ${TUCK.y * progress}px) scale(${scale})`,
    strokeWidth: `${STROKE / scale}`,
  };
};
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (2 - 2 * t) ** 3 / 2);

const circle = ref<SVGCircleElement | null>(null);
const card = ref<SVGPathElement | null>(null);
const dot = ref<SVGCircleElement | null>(null);
const turn = ref<SVGGElement | null>(null);
const arrow = ref<SVGGElement | null>(null);

onMounted(() => {
  if (!props.animate) return;
  // Each part rests at the end state and holds its first frame until its start.
  const at = (start: number, duration: number, easing = "linear"): KeyframeAnimationOptions => ({
    delay: props.delay + start,
    duration,
    easing,
    fill: "backwards",
  });
  circle.value?.animate([{ opacity: 0 }, { opacity: 1 }], at(0, 420, "ease-in-out"));
  turn.value?.animate(
    [
      { opacity: 0, transform: "rotate(-420deg) scale(0.55)" },
      { opacity: 1, transform: "rotate(-160deg) scale(0.85)", offset: 0.3 },
      { opacity: 1, transform: "rotate(0deg) scale(1)" },
    ],
    at(0, 620, "cubic-bezier(.15,.65,.3,1)"),
  );
  arrow.value?.animate(
    Array.from({ length: TUCK_STEPS + 1 }, (_, i) => tucked(easeInOutCubic(i / TUCK_STEPS))),
    at(560, 350),
  );
  card.value?.animate(
    [
      { strokeDasharray: "1 1", strokeDashoffset: 1, opacity: 0 },
      { strokeDasharray: "1 1", strokeDashoffset: 0.99, opacity: 1, offset: 0.01 },
      { strokeDasharray: "1 1", strokeDashoffset: 0, opacity: 1 },
    ],
    at(690, 450, "cubic-bezier(.45,0,.25,1)"),
  );
  dot.value?.animate(
    [{ transform: "scale(0)" }, { transform: "scale(1)" }],
    at(1040, 300, "cubic-bezier(.34,1.56,.64,1)"),
  );
});
</script>

<template>
  <svg class="transaction-icon" viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <circle ref="circle" class="transaction-icon-circle" cx="24" cy="24" r="24" />
    <g stroke="currentColor" :stroke-width="STROKE" stroke-linecap="round" stroke-linejoin="round">
      <path
        ref="card"
        d="M14 21.8777V19C14 17.8954 14.8954 17 16 17H32C33.1046 17 34 17.8954 34 19V29.6334C34 30.7379 33.1046 31.6334 32 31.6334H24"
        pathLength="1"
      />
      <circle
        ref="dot"
        class="transaction-icon-pivot"
        cx="24"
        cy="24"
        r="3"
        fill="currentColor"
        stroke="none"
      />
      <g ref="turn" class="transaction-icon-pivot">
        <g ref="arrow" class="transaction-icon-arrow" :style="tucked(1)">
          <path d="M19 29L29 19M29 19V29M29 19H19" />
        </g>
      </g>
    </g>
  </svg>
</template>

<style scoped>
/* Pocket draws money coming in as dark ink on a light circle in either theme; no semantic token
 * stays light in both (reported gap). */
.transaction-icon {
  color: var(--palette-zinc-950);
}

.transaction-icon-circle {
  fill: var(--palette-zinc-150);
}

.transaction-icon-pivot {
  transform-box: view-box;
  transform-origin: 24px 24px;
}

.transaction-icon-arrow {
  transform-box: view-box;
  transform-origin: 0 0;
}
</style>
