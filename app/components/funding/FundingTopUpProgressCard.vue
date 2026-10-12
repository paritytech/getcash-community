<script setup lang="ts">
// One row of the top-ups list, on the design's card frame: a 16px status glyph, the amount and
// what the rail is doing, and the route as a quiet pill on the right. Shared by the top-up screen
// and history, which differ only in which states they can hand it.
import { computed } from "vue";
import { Check, X } from "lucide-vue-next";
import type {
  FailedFundingTopUp,
  InProgressFundingTopUp,
  SettledFundingTopUp,
} from "../../funding/top-ups";
import { formatWhenShort } from "../../utils/journey";
import { withdrawalRequestRef } from "../../withdraw/rows";
import CashAmount from "../ui/CashAmount.vue";
import FundingProgressRing, { type ProgressRingTone } from "./progress/FundingProgressRing.vue";
import { listHeadline, overallProgress } from "./timeline/drawing";

type ProgressCardTopUp = InProgressFundingTopUp | SettledFundingTopUp | FailedFundingTopUp;

const props = withDefaults(
  defineProps<{
    topUp: ProgressCardTopUp;
    opening?: boolean;
    disabled?: boolean;
  }>(),
  {
    opening: false,
    disabled: false,
  },
);

const settled = computed(() => (props.topUp.state.kind === "settled" ? props.topUp.state : null));
const failed = computed(() => (props.topUp.state.kind === "failed" ? props.topUp.state : null));

/** The credit is the one amount the design signs and greens; everything else is what was asked
 *  for, and a failed top-up's steps back to the muted tone. */
const amountParts = computed(() => {
  const done = settled.value;
  return done
    ? { sign: "+", amount: done.creditedAmount }
    : { sign: "", amount: props.topUp.amount };
});

/** A running row's ring and status line. A top-up's come from its timeline: the overall progress
 *  once it opened, and the short headline. A withdrawal keeps its own progress. */
const running = computed<{
  value: number;
  tone: ProgressRingTone;
  status: string;
  delayed: boolean;
}>(() => {
  const { topUp } = props;
  if (withdrawalRequestRef(topUp.id) !== null) {
    const { view } = topUp.progress;
    return {
      value: view.value,
      tone: view.kind,
      status: view.label,
      delayed: topUp.delayed === true,
    };
  }
  const { timeline } = topUp;
  const { text, delayed } = listHeadline(topUp.route, timeline);
  if (timeline === undefined) return { value: 0, tone: "waiting", status: text, delayed };
  return {
    value: overallProgress(timeline.view),
    tone: delayed ? "delayed" : "active",
    status: text,
    delayed,
  };
});

const statusText = computed(() => {
  if (props.opening) return "Opening…";
  const done = settled.value;
  if (done) return formatWhenShort(done.at);
  // A failed top-up names the outcome before the moment.
  const gone = failed.value;
  return gone ? `${gone.status} · ${formatWhenShort(gone.at)}` : running.value.status;
});

const emit = defineEmits<{ open: [topUp: ProgressCardTopUp] }>();
</script>

<template>
  <button
    type="button"
    class="funding-top-up-card flex w-full items-start justify-between gap-3 bg-surface-container p-4 text-left transition-shadow"
    :disabled="disabled"
    @click="emit('open', topUp)"
  >
    <span class="flex min-w-0 items-start gap-2">
      <!-- The glyph sits on the middle of the amount's 24px line, not on its cap. -->
      <span class="mt-1 flex size-4 shrink-0 items-center justify-center">
        <Check v-if="settled" class="size-4 text-fg-success" aria-hidden="true" />
        <X v-else-if="failed" class="size-4 text-fg-error" aria-hidden="true" />
        <FundingProgressRing v-else :value="running.value" :tone="running.tone" :size="16" />
      </span>
      <span class="flex min-w-0 flex-col">
        <strong
          class="truncate text-heading-m"
          :class="settled ? 'text-fg-success' : failed ? 'text-fg-tertiary' : 'text-fg-primary'"
        >
          <CashAmount :sign="amountParts.sign" :amount="amountParts.amount" />
        </strong>
        <span
          class="truncate text-body-m"
          :class="running.delayed ? 'text-fg-warning' : 'text-fg-secondary'"
        >
          {{ statusText }}
        </span>
      </span>
    </span>

    <span class="shrink-0 rounded-full bg-surface-nested px-1 py-0.5 text-body-m text-fg-secondary">
      {{ topUp.routeLabel }}
    </span>
  </button>
</template>

<style scoped>
/* 24px; the radius scale has no semantic step this size. */
.funding-top-up-card {
  border-radius: var(--scale-radius-large);
}

.funding-top-up-card:hover:not(:disabled) {
  box-shadow: var(--shadow-1);
}
</style>
