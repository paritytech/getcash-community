<script setup lang="ts">
// The amount screens' shared frame: header, route pills, a scrolling column, the keypad and the
// bottom-anchored CTA, with the error band above the keypad. What sits between the pills and the
// keypad is the screen's own — the top-up screen puts its limits and presets there, the withdrawal
// screen its purse notice — and comes in through the slot, which hands back the grouped amount the
// display writes.
import { computed } from "vue";
import FundingEntryHeader from "./FundingEntryHeader.vue";
import FundingKeypad from "./FundingKeypad.vue";
import FundingRoutePills from "./FundingRoutePills.vue";
import PillButton from "../ui/PillButton.vue";
import type { FundingSelectorConfig } from "../../funding/config";
import { reduceFundingAmount, type FundingKey, type FundingRoute } from "../../funding/selection";
import { groupAmountDigits } from "../../utils/cash";

const props = defineProps<{
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
}>();

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

        <slot :display-amount="displayAmount" />

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
