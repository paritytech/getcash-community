<script setup lang="ts">
// The route pills over the amount: one per configured route, the picked one inverted. A route
// this build cannot run renders dimmed and marked "Soon" rather than being dropped, so the set
// the design draws stays legible.
import SkeletonBlock from "../ui/SkeletonBlock.vue";
import type { FundingRouteOption } from "../../funding/config";
import { isFundingRouteAvailable, type FundingRoute } from "../../funding/selection";

const props = withDefaults(
  defineProps<{
    routes: readonly FundingRouteOption[];
    selected: FundingRoute | null;
    /** Routes this build can run. Undefined offers every route. */
    available?: readonly FundingRoute[];
    skeleton?: boolean;
  }>(),
  { available: undefined, skeleton: false },
);

const emit = defineEmits<{ select: [route: FundingRoute] }>();

const isAvailable = (candidate: FundingRoute) =>
  isFundingRouteAvailable(candidate, props.available);
</script>

<template>
  <div v-if="skeleton" class="funding-routes" aria-hidden="true">
    <SkeletonBlock
      v-for="option in routes"
      :key="option.id"
      style="width: 5.75rem; height: 2.5rem"
    />
  </div>
  <div v-else class="funding-routes" role="radiogroup" aria-label="Funding route">
    <button
      v-for="option in routes"
      :key="option.id"
      type="button"
      class="funding-route text-label-l font-semibold"
      :class="{
        'funding-route-selected': selected === option.id,
        'funding-route-unavailable': !isAvailable(option.id),
      }"
      role="radio"
      :aria-checked="selected === option.id"
      :disabled="!isAvailable(option.id)"
      :aria-label="isAvailable(option.id) ? undefined : `${option.label}, coming soon`"
      @click="emit('select', option.id)"
    >
      <img :src="option.icon" alt="" />
      <span>{{ option.label }}</span>
      <span v-if="!isAvailable(option.id)" class="funding-route-soon text-overline">Soon</span>
    </button>
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

.funding-route:hover:not(:disabled):not(.funding-route-selected) {
  background: var(--bg-selection-container-hover);
}

.funding-route-selected {
  background: var(--bg-surface-container-inverted);
  color: var(--fg-primary-inverted);
}

/* Routes not in this build: dimmed, greyscale, no pointer response. */
.funding-route-unavailable,
.funding-route-unavailable:disabled {
  opacity: 0.35;
  cursor: not-allowed;
  pointer-events: none;
  filter: grayscale(1);
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
