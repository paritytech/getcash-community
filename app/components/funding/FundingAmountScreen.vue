<script setup lang="ts">
import { computed } from "vue";
import AvailableBalancePill from "./AvailableBalancePill.vue";
import FundingAmountDisplay from "./FundingAmountDisplay.vue";
import FundingAmountShell from "./FundingAmountShell.vue";
import type { FundingSelectorConfig } from "../../funding/config";
import CashAmount from "../ui/CashAmount.vue";
import SkeletonBlock from "../ui/SkeletonBlock.vue";
import {
  fundingAmountStatus,
  isFundingRouteAvailable,
  type FundingRoute,
} from "../../funding/selection";
import { groupAmountDigits } from "../../utils/cash";

const props = withDefaults(
  defineProps<{
    config: FundingSelectorConfig;
    amount: string;
    route: FundingRoute | null;
    /** Routes this build can run. Any other renders dimmed, marked "Soon", and unclickable. */
    availableRoutes?: readonly FundingRoute[];
    history: boolean;
    error?: string | null;
    loading?: boolean;
    /** Launch-load placeholder: static chrome (amount, keypad) renders inert while the data-driven
     *  parts (title, route pills, limits, presets, CTA label) show skeleton shapes. */
    skeleton?: boolean;
    /** The screen's title and the main action's label; the top-up wording by default. */
    title?: string;
    cta?: string;
    /** The balance the amount may be drawn from, as an amount string. Shown as a pill that fills
     *  the amount when tapped. Omit to show no pill; null shows the pill's skeleton while the
     *  balance loads. */
    available?: string | null;
  }>(),
  { title: "Top up funds", cta: "Continue to top up", available: undefined },
);

const emit = defineEmits<{
  change: [amount: string];
  route: [route: FundingRoute];
  continue: [];
  history: [];
}>();

const amountState = computed(() => fundingAmountStatus(props.amount, props.config.amount));
const canContinue = computed(
  () =>
    amountState.value.kind === "valid" &&
    props.route !== null &&
    isFundingRouteAvailable(props.route, props.availableRoutes),
);
const limitWarning = computed(
  () => amountState.value.kind === "below-minimum" || amountState.value.kind === "above-maximum",
);

/** The limit line's pieces: a bound that was broken leads with its name; the resting form is the
 *  range, whose leading figure keeps its symbol but leaves the ticker to the last. */
const limit = computed<{ lead: string; from: string | null; amount: string }>(() => {
  const { minimum, maximum } = props.config.amount;
  if (amountState.value.kind === "below-minimum")
    return { lead: "Minimum ", from: null, amount: groupAmountDigits(minimum) };
  if (amountState.value.kind === "above-maximum")
    return { lead: "Maximum ", from: null, amount: groupAmountDigits(maximum) };
  return { lead: "", from: groupAmountDigits(minimum), amount: groupAmountDigits(maximum) };
});
</script>

<template>
  <FundingAmountShell
    :config="config"
    :amount="amount"
    :route="route"
    :available-routes="availableRoutes"
    :history="history"
    :error="error"
    :loading="loading"
    :skeleton="skeleton"
    :title="title"
    :cta="cta"
    :can-continue="canContinue"
    @change="emit('change', $event)"
    @route="emit('route', $event)"
    @continue="emit('continue')"
    @history="emit('history')"
  >
    <template #default="{ displayAmount }">
      <AvailableBalancePill
        class="funding-available"
        :amount="available"
        :skeleton="skeleton"
        @fill="emit('change', $event)"
      />

      <FundingAmountDisplay class="funding-amount" :amount="displayAmount" :caret="!skeleton" />

      <SkeletonBlock v-if="skeleton" style="width: 8.125rem; height: 1rem" />
      <!-- The limit line names the bound an amount broke, so a breach has to be announced. -->
      <p
        v-else
        class="funding-limits text-body-m"
        :class="{ 'funding-limits-warning': limitWarning }"
        aria-live="polite"
      >
        {{ limit.lead
        }}<template v-if="limit.from !== null"
          ><CashAmount :amount="limit.from" :ticker="false" /> to </template
        ><CashAmount :amount="limit.amount" />
      </p>

      <div v-if="skeleton" class="funding-presets" aria-hidden="true">
        <SkeletonBlock v-for="preset in config.amount.presets" :key="preset" style="height: 3rem" />
      </div>
      <div v-else class="funding-presets" aria-label="Suggested amounts">
        <button
          v-for="preset in config.amount.presets"
          :key="preset"
          type="button"
          class="text-label-l"
          @click="emit('change', preset)"
        >
          <CashAmount :amount="groupAmountDigits(preset)" />
        </button>
      </div>
    </template>
  </FundingAmountShell>
</template>

<style scoped>
/* Layout only; the pill's look is AvailableBalancePill's. */
.funding-available {
  margin-top: 1.5rem;
}

.funding-amount {
  margin-top: 1.5rem;
}

/* The pill takes the gap the amount row would otherwise open. */
.funding-available + .funding-amount {
  margin-top: 0.75rem;
}

.funding-limits {
  min-height: 1rem;
  color: var(--fg-secondary);
  text-align: center;
  transition: color 150ms ease;
}

.funding-limits-warning {
  color: var(--fg-error);
  font-weight: 500;
}

.funding-presets {
  display: grid;
  width: 100%;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.5rem;
  margin-top: 1.5rem;
  padding: 0 0.5rem;
}

.funding-presets button {
  min-width: 0;
  height: 3rem;
  border-radius: 9999px;
  background: var(--bg-surface-nested);
  padding: 0 1rem;
  overflow: hidden;
  white-space: nowrap;
  transition: background-color 120ms ease-out;
}

.funding-presets button:hover {
  background: var(--bg-selection-container-hover);
}

@media (max-height: 650px) {
  .funding-amount {
    margin-top: 0.75rem;
  }

  .funding-presets {
    margin-top: 0.75rem;
  }

  .funding-presets button {
    height: 2.625rem;
  }
}
</style>
