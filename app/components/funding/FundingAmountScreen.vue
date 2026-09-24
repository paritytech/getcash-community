<script setup lang="ts">
import { computed } from "vue";
import FundingAmountDisplay from "./FundingAmountDisplay.vue";
import FundingAmountShell from "./FundingAmountShell.vue";
import CashAmount from "../ui/CashAmount.vue";
import SkeletonBlock from "../ui/SkeletonBlock.vue";
import type { AmountScreenEmits, AmountScreenProps } from "../../funding/amount-screen";
import { fundingAmountStatus, isFundingRouteAvailable } from "../../funding/selection";
import { groupAmountDigits } from "../../utils/cash";

const props = withDefaults(defineProps<AmountScreenProps>(), {
  title: "Top up funds",
  cta: "Continue to top up",
  available: undefined,
});

const emit = defineEmits<AmountScreenEmits>();

const amountState = computed(() => fundingAmountStatus(props.amount, props.config.amount));
const canContinue = computed(
  () =>
    amountState.value.kind === "valid" &&
    props.route !== null &&
    isFundingRouteAvailable(props.route, props.availableRoutes),
);

// The limit line names the bound an amount broke; inside the bounds the range stands, its leading
// figure keeping the symbol but leaving the ticker to the last.
const notice = computed(() => {
  const { minimum, maximum } = props.config.amount;
  if (amountState.value.kind === "below-minimum")
    return { lead: "Minimum ", amount: groupAmountDigits(minimum), breach: true };
  if (amountState.value.kind === "above-maximum")
    return { lead: "Maximum ", amount: groupAmountDigits(maximum), breach: true };
  return {
    lead: "",
    from: groupAmountDigits(minimum),
    amount: groupAmountDigits(maximum),
    breach: false,
  };
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
    :available="available"
    :notice="notice"
    @change="emit('change', $event)"
    @route="emit('route', $event)"
    @continue="emit('continue')"
    @history="emit('history')"
  >
    <template #default="{ displayAmount }">
      <FundingAmountDisplay class="funding-amount" :amount="displayAmount" :caret="!skeleton" />
    </template>

    <template #after>
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
.funding-amount {
  margin-top: 1.5rem;
}

/* The pill takes the gap the amount row would otherwise open. */
.amount-shell-available + .funding-amount {
  margin-top: 0.75rem;
}

/* The top-up frames weight a broken bound; the withdrawal frames keep the shell's plain line. */
:deep(.amount-shell-notice-breach) {
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
