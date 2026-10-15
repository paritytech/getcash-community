<script setup lang="ts">
// A soft flip clock: the old text drops and dissolves while the new one comes down from above.
// When the height changes, the box resizes in an order that never shows text cut by its edge.
import { nextTick, ref, watch } from "vue";

const props = defineProps<{
  text: string | null;
  variant: "message" | "detail";
}>();

const FLIPS = {
  message: { distance: 14, blur: 3, outMs: 560, inMs: 680, inDelayMs: 200 },
  detail: { distance: 8, blur: 2, outMs: 520, inMs: 640, inDelayMs: 180 },
} as const;
const RESIZE_MS = 520;
const GROW_IN_AT = 0.7;
const SHRINK_OUT_MS = 360;
const SHRINK_RESIZE_DELAY_MS = 220;
const SHRINK_IN_DELAY_MS = 300;
const EASE_OUT = "cubic-bezier(.45,0,.55,1)";
const EASE_IN = "cubic-bezier(.25,.6,.25,1)";

const root = ref<HTMLElement | null>(null);
const current = ref<HTMLElement | null>(null);
const ghostEl = ref<HTMLElement | null>(null);
const shown = ref(props.text);
const ghost = ref<string | null>(null);
const clipped = ref(false);
let flip = 0;

const frame = (offset: number, blur: number, opacity: number): Keyframe => ({
  opacity,
  filter: `blur(${blur}px)`,
  transform: `translateY(${offset}px)`,
});

watch(
  () => props.text,
  async (next, previous) => {
    const box = root.value;
    if (box === null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      shown.value = next;
      ghost.value = null;
      return;
    }
    const run = ++flip;
    const from = box.getBoundingClientRect().height;
    box.getAnimations({ subtree: true }).forEach((animation) => animation.cancel());
    ghost.value = previous;
    shown.value = next;
    clipped.value = true;
    await nextTick();
    if (run !== flip) return;

    const to = box.getBoundingClientRect().height;
    const grow = to - from > 1;
    const shrink = from - to > 1;
    const { distance, blur, outMs, inMs, inDelayMs } = FLIPS[props.variant];
    const leaving = ghostEl.value?.animate([frame(0, 0, 1), frame(distance, blur, 0)], {
      duration: shrink ? SHRINK_OUT_MS : outMs,
      easing: EASE_OUT,
      fill: "forwards",
    });
    const entering = current.value?.animate([frame(-distance, blur, 0), frame(0, 0, 1)], {
      duration: inMs,
      delay: grow ? RESIZE_MS * GROW_IN_AT : shrink ? SHRINK_IN_DELAY_MS : inDelayMs,
      easing: EASE_IN,
      fill: "backwards",
    });
    const resizing =
      grow || shrink
        ? box.animate([{ height: `${from}px` }, { height: `${to}px` }], {
            duration: RESIZE_MS,
            delay: shrink ? SHRINK_RESIZE_DELAY_MS : 0,
            easing: EASE_OUT,
            fill: "backwards",
          })
        : undefined;
    const settled = await Promise.allSettled(
      [leaving, entering, resizing].map((animation) => animation?.finished),
    );
    if (run !== flip || settled.some(({ status }) => status === "rejected")) return;
    ghost.value = null;
    clipped.value = false;
  },
  { flush: "pre" },
);
</script>

<template>
  <div ref="root" class="flip" :class="[`flip-${variant}`, { 'flip-clipped': clipped }]">
    <span v-if="shown" ref="current" class="flip-text">{{ shown }}</span>
    <span v-if="ghost" ref="ghostEl" class="flip-text flip-ghost" aria-hidden="true">
      {{ ghost }}
    </span>
  </div>
</template>

<style scoped>
.flip {
  position: relative;
  padding-inline: 1.125rem;
  text-align: center;
}

.flip-clipped {
  overflow: hidden;
}

.flip-text {
  display: block;
}

.flip-ghost {
  position: absolute;
  inset-inline: 1.125rem;
  pointer-events: none;
}

.flip-message {
  min-height: 2rem;
  padding-block: 7px;
}

.flip-message .flip-ghost {
  top: 7px;
}

/* The detail line overlaps the message's bottom padding: the band keeps its 32 px without one,
 * and a detail line sits 2 px below the message's line box. */
.flip-detail {
  min-height: 7px;
  margin-top: -7px;
}

.flip-detail .flip-text {
  padding: 2px 0 7px;
}

.flip-detail .flip-ghost {
  top: 0;
}
</style>
