<script setup lang="ts">
// The amount screens' shared frame: header, route pills, purse pill, notice line, keypad and
// bottom-anchored CTA. The screen's own middle comes in through the slots, which hand back the
// grouped amount the display writes.
import { computed } from "vue";
import AvailableBalancePill from "./AvailableBalancePill.vue";
import CashAmount from "../ui/CashAmount.vue";
import FundingEntryHeader from "./FundingEntryHeader.vue";
import FundingKeypad from "./FundingKeypad.vue";
import FundingRoutePills from "./FundingRoutePills.vue";
import PillButton from "../ui/PillButton.vue";
import SkeletonBlock from "../ui/SkeletonBlock.vue";
import type { FundingSelectorConfig } from "../../funding/config";
import { reduceFundingAmount, type FundingKey, type FundingRoute } from "../../funding/selection";
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
    /** Launch-load placeholder: static chrome renders inert, data-driven parts show skeletons. */
    skeleton?: boolean;
    title: string;
    cta: string;
    /** The screen's gate; held at the emit too, so a click that slips the styling opens nothing. */
    canContinue: boolean;
    /** The purse in base units of CASH; omit to show no pill, null for the pill's skeleton. */
    available?: bigint | null;
    /** The line under the amount, as the pieces CashAmount draws; a breach takes the error colour. */
    notice: { lead: string; from?: string | null; amount?: string | null; breach: boolean };
  }>(),
  { available: undefined },
);

const emit = defineEmits<{
  change: [amount: string];
  route: [route: FundingRoute];
  continue: [];
  history: [];
}>();

const displayAmount = computed(() => (props.amount === "" ? "0" : groupAmountDigits(props.amount)));

function enter(key: FundingKey) {
  emit("change", reduceFundingAmount(props.amount, key, props.config.amount.decimals));
}

function requestContinue() {
  if (props.skeleton || props.loading || !props.canContinue) return;
  emit("continue");
}
</script>

<template>
  <div class="amount-shell">
    <FundingEntryHeader
      :title="title"
      :history="history"
      :skeleton="skeleton"
      @history="emit('history')"
    />

    <div class="amount-shell-scroll">
      <div class="amount-shell-content">
        <FundingRoutePills
          :routes="config.routes"
          :selected="route"
          :available="availableRoutes"
          :skeleton="skeleton"
          @select="emit('route', $event)"
        />

        <AvailableBalancePill
          class="amount-shell-available"
          :amount="available"
          :decimals="config.amount.decimals"
          :skeleton="skeleton"
          @fill="emit('change', $event)"
        />

        <slot :display-amount="displayAmount" />

        <SkeletonBlock v-if="skeleton" style="width: 8.125rem; height: 1rem" />
        <!-- The notice names the bound an amount broke, so a breach has to be announced. -->
        <p
          v-else
          class="amount-shell-notice text-body-m"
          :class="{ 'amount-shell-notice-breach': notice.breach }"
          aria-live="polite"
        >
          {{ notice.lead
          }}<template v-if="notice.from != null"
            ><CashAmount :amount="notice.from" :ticker="false" /> to </template
          ><CashAmount v-if="notice.amount != null" :amount="notice.amount" />
        </p>

        <slot name="after" :display-amount="displayAmount" />

        <p v-if="error" class="amount-shell-error text-caption" role="alert">{{ error }}</p>

        <FundingKeypad :disabled="skeleton" @key="enter" />

        <PillButton
          class="amount-shell-primary"
          :disabled="skeleton || loading || !canContinue"
          @click="requestContinue"
        >
          {{ skeleton ? "" : loading ? `Opening ${config.provider}…` : cta }}
        </PillButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.amount-shell {
  display: flex;
  min-height: 0;
  height: 100%;
  flex-direction: column;
}

.amount-shell-scroll {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.amount-shell-content {
  display: flex;
  min-height: 100%;
  flex-direction: column;
  align-items: center;
  padding: 1rem;
  color: var(--fg-primary);
}

.amount-shell-available {
  margin-top: 1.5rem;
}

.amount-shell-notice {
  min-height: var(--scale-line-height-20);
  color: var(--fg-secondary);
  text-align: center;
  transition: color 150ms ease;
}

.amount-shell-notice-breach {
  color: var(--fg-error);
}

/* The error renders inside the fixed 24px band above the keypad, so showing it never shifts the pad. */
.amount-shell-error {
  min-height: 1rem;
  margin-top: 0.5rem;
  margin-bottom: -1.5rem;
  color: var(--fg-error);
  text-align: center;
}

/* The auto margin anchors the CTA to the bottom. */
.amount-shell-primary {
  width: 100%;
  margin-top: auto;
}

@media (max-height: 650px) {
  .amount-shell-content {
    padding-bottom: 0.75rem;
  }
}
</style>
