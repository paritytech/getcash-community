<script setup lang="ts">
// A country's flag, drawn as the design's circle.
//
// The artwork is whatever sits in `app/assets/flags` as `<alpha-2>.svg`, picked up at build time:
// committing a file is all it takes to light a country up. A country with no artwork yet falls
// back to the regional-indicator emoji rather than a hole, so the list is never missing a row's
// identity.
import { computed } from "vue";
import { flagEmoji } from "~~/lib/supported";

const props = withDefaults(defineProps<{ country: string; size?: number }>(), { size: 48 });

const ART = import.meta.glob("../../assets/flags/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const src = computed<string | null>(() => {
  const cc = props.country.trim().toLowerCase();
  return ART[`../../assets/flags/${cc}.svg`] ?? null;
});
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center justify-center overflow-clip rounded-full"
    :style="{ width: `${size}px`, height: `${size}px` }"
    aria-hidden="true"
  >
    <img v-if="src" :src="src" alt="" class="size-full" />
    <!-- The emoji carries its own shape, so it sits on the surface plate the artwork would fill. -->
    <span
      v-else
      class="flex size-full items-center justify-center rounded-full bg-surface-nested leading-none"
      :style="{ fontSize: `${Math.round(size * 0.58)}px` }"
      >{{ flagEmoji(country) }}</span
    >
  </span>
</template>
