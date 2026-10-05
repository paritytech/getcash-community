<script setup lang="ts">
// The Fees drill-in behind the sale's quote: the provider's fee split as it reported it, the total,
// what reaches the seller, what comes back to the balance, and the rate. On a sale the fees are
// fiat and come off the payout. Read-only; the toolbar and the bottom button both return to the
// quote.
import { computed } from "vue";
import type { MeldSellQuote } from "../../composables/useMeldSellQuote";
import { cashAmount, fmtCash } from "../../utils/cash";
import { fmtFiat, isMoneyAmount } from "../../utils/money";
import { backCashText } from "../../withdraw/sale-back";
import DetailRows from "../ui/DetailRows.vue";
import PillButton from "../ui/PillButton.vue";

const props = defineProps<{
  quote: MeldSellQuote;
  /** The CASH leaving the balance, for the rate line. */
  cashAmount: string;
}>();
const emit = defineEmits<{ back: [] }>();

const fiat = computed(() => props.quote.fiat);

/** The components as the provider named them; a component it did not report is not shown. */
const feeRows = computed(() => {
  const { line } = props.quote;
  return [
    { label: "Provider fee", amount: line.transactionFee },
    { label: "Network fee", amount: line.networkFee },
    { label: "Service fee", amount: line.partnerFee },
  ].flatMap(({ label, amount }) =>
    isMoneyAmount(amount) && Number(amount) > 0
      ? [{ label, value: fmtFiat(amount, fiat.value) }]
      : [],
  );
});

const totalRows = computed(() => {
  const total = props.quote.line.totalFee;
  return isMoneyAmount(total) ? [{ label: "Total fees", value: fmtFiat(total, fiat.value) }] : [];
});

const payout = computed(() => fmtFiat(props.quote.line.destinationAmount, fiat.value));

const back = computed(() => backCashText(props.quote.backCash));

/** Fiat per CASH the payout uses, fees taken: the CASH that comes back is not sold for it. */
const rate = computed(() => {
  const cash = Number(props.cashAmount.replace(/,/g, "")) - Number(fmtCash(props.quote.backCash));
  const out = Number(props.quote.line.destinationAmount);
  if (!Number.isFinite(cash) || cash <= 0 || !Number.isFinite(out) || out <= 0) return null;
  return `${cashAmount("1")} ≈ ${fmtFiat((out / cash).toFixed(2), fiat.value)}`;
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <template v-if="feeRows.length">
      <DetailRows class="gap-2" :rows="feeRows" muted />
      <hr class="my-2 border-stroke-secondary" />
    </template>

    <DetailRows class="gap-2" :rows="totalRows" muted />

    <hr class="my-2 border-stroke-secondary" />

    <div class="mt-2 flex flex-col gap-1">
      <div class="flex items-center justify-between gap-4">
        <span class="text-paragraph-l text-fg-secondary">You'll receive</span>
        <span class="text-display-l text-fg-primary">≈ {{ payout }}</span>
      </div>
      <div v-if="back" class="flex items-baseline justify-between gap-4">
        <span class="text-paragraph-l text-fg-secondary">Back to your balance</span>
        <span class="text-paragraph-l text-fg-secondary">≈ {{ back }}</span>
      </div>
      <div v-if="rate" class="flex items-baseline justify-between gap-4">
        <span class="text-paragraph-l text-fg-secondary">Rate</span>
        <span class="text-paragraph-l text-fg-secondary">{{ rate }}</span>
      </div>
    </div>

    <PillButton variant="tertiary" class="mt-auto mb-6 w-full" @click="emit('back')">
      Back
    </PillButton>
  </div>
</template>
