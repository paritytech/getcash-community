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
import FundingProgressRing from "./progress/FundingProgressRing.vue";

type ProgressCardTopUp = InProgressFundingTopUp | SettledFundingTopUp | FailedFundingTopUp;

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

const settled = computed(() => (props.topUp.state.kind === "settled" ? props.topUp.state : null));
const failed = computed(() => (props.topUp.state.kind === "failed" ? props.topUp.state : null));

/** The credit is the one amount the design signs and greens; everything else is what was asked
 *  for, and a failed top-up's steps back to the muted tone. */
const amountText = computed(() => {
  const done = settled.value;
  return done ? `+${done.creditedAmount} ${props.asset}` : `${props.topUp.amount} ${props.asset}`;
});

const statusText = computed(() => {
  if (props.opening) return "Opening…";
  const done = settled.value;
  if (done) return formatWhenShort(done.at);
  // A failed top-up names the outcome before the moment; a running one is the rail's own word.
  const gone = failed.value;
  return gone ? `${gone.status} · ${formatWhenShort(gone.at)}` : props.topUp.progress.view.label;
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
        <FundingProgressRing v-else :progress="topUp.progress" :size="16" />
      </span>
      <span class="flex min-w-0 flex-col">
        <strong
          class="truncate text-heading-m"
          :class="settled ? 'text-fg-success' : failed ? 'text-fg-tertiary' : 'text-fg-primary'"
        >
          {{ amountText }}
        </strong>
        <span
          class="truncate text-body-m"
          :class="topUp.delayed ? 'text-fg-warning' : 'text-fg-secondary'"
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
