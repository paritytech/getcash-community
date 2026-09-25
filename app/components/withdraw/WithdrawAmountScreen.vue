<script setup lang="ts">
// The withdrawal amount screen, at the entry to #/withdraw: the top-up screen's shape drawn to
// the withdrawal frames, with no preset amounts.
import { computed } from "vue";
import FundingAmountDisplay from "../funding/FundingAmountDisplay.vue";
import FundingAmountShell from "../funding/FundingAmountShell.vue";
import type { AmountScreenEmits, AmountScreenProps } from "../../funding/amount-screen";
import { isFundingRouteAvailable } from "../../funding/selection";
import { assessWithdrawalAmount } from "../../withdraw/amount";

const props = withDefaults(defineProps<AmountScreenProps>(), {
  title: "Withdraw funds",
  cta: "Continue",
  available: undefined,
});

const emit = defineEmits<AmountScreenEmits>();

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
    :available="available"
    :notice="notice"
    @change="emit('change', $event)"
    @route="emit('route', $event)"
    @continue="emit('continue')"
    @history="emit('history')"
  >
    <template #default="{ displayAmount }">
      <FundingAmountDisplay class="withdraw-amount" :amount="displayAmount" :caret="!skeleton" />
    </template>
  </FundingAmountShell>
</template>

<style scoped>
.withdraw-amount {
  margin-top: 1.5rem;
}

/* The pill takes the gap the amount row would otherwise open. */
.amount-shell-available + .withdraw-amount {
  margin-top: 0.5rem;
}

@media (max-height: 650px) {
  .withdraw-amount {
    margin-top: 0.75rem;
  }
}
</style>
