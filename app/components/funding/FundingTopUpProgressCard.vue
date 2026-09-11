<script setup lang="ts">
import { computed } from "vue";
import { ChevronRight } from "lucide-vue-next";
import { formatFundingHistoryWhen } from "../../funding/history";
import type { InProgressFundingTopUp, SettledFundingTopUp } from "../../funding/top-ups";
import FundingProgressRing from "./progress/FundingProgressRing.vue";

type ProgressCardTopUp = InProgressFundingTopUp | SettledFundingTopUp;

const props = withDefaults(
  defineProps<{
    topUp: ProgressCardTopUp;
    asset: string;
    opening?: boolean;
    disabled?: boolean;
  }>(),
  {
    opening: false,
    disabled: false,
  },
);

const status = computed(() =>
  props.topUp.state.kind === "settled" ? "Added to your balance" : props.topUp.progress.view.label,
);
const detail = computed(() =>
  props.topUp.state.kind === "settled"
    ? formatFundingHistoryWhen(props.topUp.state.at)
    : props.topUp.progress.estimateText,
);

const emit = defineEmits<{ open: [topUp: ProgressCardTopUp] }>();
</script>

<template>
  <button
    type="button"
    class="funding-top-up-card"
    :disabled="disabled"
    @click="emit('open', topUp)"
  >
    <FundingProgressRing :progress="topUp.progress" />
    <span class="funding-top-up-copy">
      <strong class="text-heading-s"
        >{{ topUp.amount }} {{ asset }} by {{ topUp.routeLabel }}</strong
      >
      <span class="funding-top-up-status text-caption">{{ opening ? "Opening…" : status }}</span>
      <span class="funding-top-up-detail text-caption">{{ detail }}</span>
    </span>
    <ChevronRight class="size-4 flex-none text-fg-secondary" aria-hidden="true" />
  </button>
</template>

<style scoped>
.funding-top-up-card {
  /* Depth is the container surface plus shadow-1; no group border. */
  display: flex;
  width: 100%;
  align-items: center;
  gap: 0.75rem;
  border-radius: var(--radius-container);
  background: var(--bg-surface-container);
  box-shadow: var(--shadow-1);
  padding: 1rem;
  color: var(--fg-primary);
  text-align: left;
  transition: box-shadow 150ms ease;
}

.funding-top-up-card:hover:not(:disabled) {
  box-shadow: var(--shadow-2);
}

.funding-top-up-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}

.funding-top-up-copy strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.funding-top-up-status {
  margin-top: 0.25rem;
  overflow: hidden;
  color: var(--fg-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.funding-top-up-detail {
  margin-top: 0.125rem;
  color: var(--fg-secondary);
}
</style>
