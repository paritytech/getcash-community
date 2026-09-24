<script setup lang="ts">
// The withdrawal amount screen, at the entry to #/withdraw. The top-up screen's shape — route
// pills, the purse pill, the amount, the keypad, the CTA — drawn to the withdrawal frames: the
// amount in CashAmount's treatment, the line underneath names whichever bound the amount broke,
// and there are no preset amounts.
import { computed } from "vue";
import AvailableBalancePill from "../funding/AvailableBalancePill.vue";
import FundingAmountDisplay from "../funding/FundingAmountDisplay.vue";
import FundingAmountShell from "../funding/FundingAmountShell.vue";
import SkeletonBlock from "../ui/SkeletonBlock.vue";
import type { FundingSelectorConfig } from "../../funding/config";
import { isFundingRouteAvailable, type FundingRoute } from "../../funding/selection";
import { assessWithdrawalAmount } from "../../withdraw/amount";

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
     *  parts (title, route pills, the purse line, CTA label) show skeleton shapes. */
    skeleton?: boolean;
    /** The screen's title and the main action's label. */
    title?: string;
    cta?: string;
    /** The purse the amount is drawn from, as an amount string. Shown as a pill that fills the
     *  amount when tapped. Omit to show no pill; null shows the pill's skeleton while it loads. */
    available?: string | null;
  }>(),
  { title: "Withdraw funds", cta: "Continue", available: undefined },
);

const emit = defineEmits<{
  change: [amount: string];
  route: [route: FundingRoute];
  continue: [];
  history: [];
}>();

// One reading of the amount serves both the line underneath and the CTA's gate.
const notice = computed(() => assessWithdrawalAmount(props.amount, props.config, props.available));

const canContinue = computed(
  () =>
    notice.value.withdrawable &&
    props.route !== null &&
    isFundingRouteAvailable(props.route, props.availableRoutes),
);
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
        class="withdraw-available"
        :amount="available"
        :skeleton="skeleton"
        @fill="emit('change', $event)"
      />

      <FundingAmountDisplay class="withdraw-amount" :amount="displayAmount" :caret="!skeleton" />

      <SkeletonBlock v-if="skeleton" style="width: 8.125rem; height: 1rem" />
      <!-- The line names the bound an amount broke, so a breach has to be announced. -->
      <p
        v-else
        class="withdraw-notice text-body-m"
        :class="{ 'withdraw-notice-breach': notice.breach }"
        aria-live="polite"
      >
        {{ notice.text }}
      </p>
    </template>
  </FundingAmountShell>
</template>

<style scoped>
/* Layout only; the pill's look is AvailableBalancePill's. */
.withdraw-available {
  margin-top: 1.5rem;
}

.withdraw-amount {
  margin-top: 1.5rem;
}

/* The pill takes the gap the amount row would otherwise open. */
.withdraw-available + .withdraw-amount {
  margin-top: 0.5rem;
}

.withdraw-notice {
  min-height: 1rem;
  color: var(--fg-secondary);
  text-align: center;
  transition: color 150ms ease;
}

.withdraw-notice-breach {
  color: var(--fg-error);
}

@media (max-height: 650px) {
  .withdraw-amount {
    margin-top: 0.75rem;
  }
}
</style>
