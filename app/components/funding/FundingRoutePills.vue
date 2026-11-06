<script setup lang="ts">
// A route this build cannot run renders dimmed and marked "Soon" rather than dropped. One the
// backend cannot serve right now is dimmed too, and a tap on it, or losing it while selected, says
// why for a few seconds: a label inside the pill would not fit three pills on a phone.
import { onBeforeUnmount, ref, watch } from "vue";
import SkeletonBlock from "../ui/SkeletonBlock.vue";
import type { FundingRouteOption } from "../../funding/config";
import { isFundingRouteAvailable, type FundingRoute } from "../../funding/selection";

const props = withDefaults(
  defineProps<{
    routes: readonly FundingRouteOption[];
    selected: FundingRoute | null;
    /** Routes this build can run. Undefined offers every route. */
    available?: readonly FundingRoute[];
    /** Routes the backend cannot serve right now. Not in `available`. */
    unserved?: readonly FundingRoute[];
    skeleton?: boolean;
  }>(),
  { available: undefined, unserved: () => [], skeleton: false },
);

const emit = defineEmits<{ select: [route: FundingRoute] }>();

const isAvailable = (candidate: FundingRoute) =>
  isFundingRouteAvailable(candidate, props.available);
const isUnserved = (candidate: FundingRoute) => props.unserved.includes(candidate);

const NOTICE_MS = 3000;
const notice = ref<string | null>(null);
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

function sayUnserved(route: FundingRoute) {
  const label = props.routes.find((option) => option.id === route)?.label ?? route;
  notice.value = `${label} isn't available right now`;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.value = null;
  }, NOTICE_MS);
}

function tap(option: FundingRouteOption) {
  if (isUnserved(option.id)) sayUnserved(option.id);
  else emit("select", option.id);
}

watch(
  () => [props.selected, props.unserved] as const,
  ([, unserved], [before]) => {
    if (before !== null && unserved.includes(before)) sayUnserved(before);
  },
);

onBeforeUnmount(() => clearTimeout(noticeTimer));
</script>

<template>
  <div v-if="skeleton" class="funding-routes" aria-hidden="true">
    <SkeletonBlock
      v-for="option in routes"
      :key="option.id"
      style="width: 5.75rem; height: 2.5rem"
    />
  </div>
  <div v-else class="relative w-full">
    <div class="funding-routes" role="radiogroup" aria-label="Funding route">
      <button
        v-for="option in routes"
        :key="option.id"
        type="button"
        class="funding-route text-label-l font-semibold"
        :class="{
          'funding-route-selected': selected === option.id,
          'funding-route-unavailable': !isAvailable(option.id) && !isUnserved(option.id),
          'funding-route-unserved': isUnserved(option.id),
        }"
        role="radio"
        :aria-checked="selected === option.id"
        :disabled="!isAvailable(option.id) && !isUnserved(option.id)"
        :aria-disabled="isUnserved(option.id) || undefined"
        :aria-label="
          isAvailable(option.id)
            ? undefined
            : `${option.label}, ${isUnserved(option.id) ? 'unavailable right now' : 'coming soon'}`
        "
        @click="tap(option)"
      >
        <img :src="option.icon" alt="" />
        <span>{{ option.label }}</span>
        <span
          v-if="!isAvailable(option.id) && !isUnserved(option.id)"
          class="funding-route-soon text-overline"
          >Soon</span
        >
      </button>
    </div>
    <!-- Out of flow, in the gap above the balance pill, so nothing below moves while it shows. -->
    <p
      v-if="notice"
      class="absolute inset-x-0 top-full mt-1 text-center text-caption text-fg-secondary"
      role="status"
    >
      {{ notice }}
    </p>
  </div>
</template>

<style scoped>
.funding-routes {
  display: flex;
  width: 100%;
  justify-content: center;
  gap: 0.5rem;
}

.funding-route {
  display: flex;
  min-width: 0;
  height: 2.5rem;
  align-items: center;
  gap: 0.5rem;
  border-radius: 9999px;
  background: var(--bg-surface-container);
  padding: 0 0.75rem 0 0.5rem;
  color: var(--fg-primary);
  transition:
    background-color 120ms ease-out,
    color 120ms ease-out;
}

.funding-route:hover:not(:disabled):not(.funding-route-selected):not(.funding-route-unserved) {
  background: var(--bg-selection-container-hover);
}

.funding-route-selected {
  background: var(--bg-surface-container-inverted);
  color: var(--fg-primary-inverted);
}

/* Dimmed and greyscale. A route not in this build takes no pointer; one the backend cannot serve
   right now still takes the tap that says why. */
.funding-route-unavailable,
.funding-route-unserved {
  opacity: 0.35;
  filter: grayscale(1);
}

.funding-route-unavailable,
.funding-route-unavailable:disabled {
  cursor: not-allowed;
  pointer-events: none;
}

.funding-route-unserved {
  cursor: default;
}

.funding-route-soon {
  text-transform: uppercase;
  color: var(--fg-tertiary);
}

.funding-route img {
  width: 1.5rem;
  height: 1.5rem;
  flex: none;
  border-radius: 9999px;
}
</style>
