<script setup lang="ts">
import { computed } from "vue";
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
      <strong>{{ topUp.amount }} {{ asset }} by {{ topUp.routeLabel }}</strong>
      <span class="funding-top-up-status">{{ opening ? "Opening…" : status }}</span>
      <span class="funding-top-up-detail">{{ detail }}</span>
    </span>
    <span class="funding-top-up-chevron" aria-hidden="true">›</span>
  </button>
</template>

<style scoped>
.funding-top-up-card {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 0.75rem;
  border: 1px solid color-mix(in srgb, var(--funding-border) 45%, transparent);
  border-radius: 1.125rem;
  background: var(--funding-surface);
  padding: 1rem;
  text-align: left;
}

.funding-top-up-card:disabled {
  cursor: default;
}

.funding-top-up-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}

.funding-top-up-copy strong {
  overflow: hidden;
  font-size: 0.84375rem;
  line-height: 1.125rem;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.funding-top-up-status {
  margin-top: 0.25rem;
  overflow: hidden;
  color: var(--funding-text-muted);
  font-size: 0.71875rem;
  line-height: 1rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.funding-top-up-detail {
  margin-top: 0.125rem;
  color: var(--funding-text-muted);
  font-size: 0.6875rem;
  line-height: 0.9375rem;
}

.funding-top-up-chevron {
  flex: none;
  color: var(--funding-text-muted);
  font-size: 1rem;
  line-height: 1;
}
</style>
