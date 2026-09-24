<script setup lang="ts">
// The amount screens' shared frame: header, route pills, the purse pill, a scrolling column, the
// notice line, the keypad and the bottom-anchored CTA, with the error band above the keypad. The
// pill and the notice belong here because both screens draw them the same way — only their words
// and spacing differ. What sits between them is the screen's own — the amount display, and for the
// top-up screen its presets — and comes in through the slots, which hand back the grouped amount
// the display writes.
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
    /** Launch-load placeholder: static chrome (amount, keypad) renders inert while the data-driven
     *  parts show skeleton shapes. */
    skeleton?: boolean;
    title: string;
    cta: string;
    /** The screen's own gate. It holds at the emit too, not only at the button's disabled
     *  attribute, so a click that slipped the styling gate opens nothing. */
    canContinue: boolean;
    /** The balance the amount may be drawn from, in base units of CASH; the pill offers it to the
     *  keypad. Omit to show no pill; null shows the pill's skeleton while the balance loads. */
    available?: bigint | null;
    /** The line under the amount: the screen's reading of what the entered amount means, as the
     *  pieces CashAmount draws — the words leading the figure (or the whole line where there is
     *  no figure), an optional range opener whose figure keeps its symbol but leaves the ticker
     *  to the last, and the closing figure. A breach is written in the error colour. */
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

        <!-- Layout only; the pill's look is AvailableBalancePill's. -->
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
  min-height: 1rem;
  color: var(--fg-secondary);
  text-align: center;
  transition: color 150ms ease;
}

.amount-shell-notice-breach {
  color: var(--fg-error);
}

/* The error renders inside the fixed 24px band above the keypad (8px margin + 16px line − 24px
   pull-back), so showing it never shifts the pad. */
.amount-shell-error {
  min-height: 1rem;
  margin-top: 0.5rem;
  margin-bottom: -1.5rem;
  color: var(--fg-error);
  text-align: center;
}

/* Layout only; the pill's look is PillButton's. The auto margin anchors the CTA to the bottom. */
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
