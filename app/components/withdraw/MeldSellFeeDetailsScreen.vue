<script setup lang="ts">
// The Fees drill-in behind the sell quote's hero caption: the quoted fee split, its total, and
// the estimated payout it nets to. Shaped like the buy side's `MeldFeeDetailsScreen.vue`; the one
// structural difference is the sell has no funding-leg chain fee to add on top of the rail's own
// split, since nothing here moves a second leg the rail does not already see.
import { computed } from "vue";
import type { MeldQuoteEntry } from "@getsome/meld";
import { fmtFiat, isMoneyAmount } from "../../utils/money";
import { formatEstimatedPayout } from "../../withdraw/meld-sell";
import DetailRows from "../ui/DetailRows.vue";
import PillButton from "../ui/PillButton.vue";

const props = defineProps<{
  /** The exact crypto this withdrawal commits, formatted (e.g. "12.5 DOT"). */
  committedText: string;
  entry: MeldQuoteEntry;
  fiat: string;
}>();
const emit = defineEmits<{ back: [] }>();

/** The fee's components, as the rail reported them. Read rather than derived, the same discipline
 *  the buy side's breakdown follows: a component the quote did not send is simply not shown. */
const feeRows = computed(() => {
  const q = props.entry;
  return [
    { label: "Provider fee", amount: q.transactionFee },
    { label: "Network fee", amount: q.networkFee },
    { label: "Service fee", amount: q.partnerFee },
  ].flatMap(({ label, amount }) =>
    isMoneyAmount(amount) && Number(amount) > 0
      ? [{ label, value: fmtFiat(amount, props.fiat) }]
      : [],
  );
});

const totalRows = computed(() => {
  const total = props.entry.totalFee;
  return isMoneyAmount(total) ? [{ label: "Total fees", value: fmtFiat(total, props.fiat) }] : [];
});

/** The estimated payout: always "≈", the same helper the quote screen and the journey use, so
 *  this drill-in cannot drop the mark the other two carry. */
const payout = computed(() => formatEstimatedPayout(props.entry.destinationAmount, props.fiat));
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
        <span class="text-paragraph-l text-fg-secondary">Selling</span>
        <span class="text-display-l text-fg-primary">{{ committedText }}</span>
      </div>
      <div class="flex items-baseline justify-between gap-4">
        <span class="text-paragraph-l text-fg-secondary">Estimated payout</span>
        <span class="text-paragraph-l text-fg-secondary">{{ payout }}</span>
      </div>
    </div>
    <p class="mt-2 text-body-s text-fg-tertiary">
      The provider has not locked this in — it prices the sale for real only once it converts your
      crypto.
    </p>

    <PillButton variant="tertiary" class="mt-auto mb-6 w-full" @click="emit('back')">
      Back
    </PillButton>
  </div>
</template>
