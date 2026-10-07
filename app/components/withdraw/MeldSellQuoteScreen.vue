<script setup lang="ts">
// The sale before the seller verifies: the CASH leaving the balance, the payout country, what the
// provider says it pays out for the exact figure the key will send, and what comes back of the
// part held for the price to move. Continue opens the provider's page for KYC; nothing is asked of
// the balance until the provider names where the funds go.
import { computed } from "vue";
import type { MeldSellQuote } from "../../composables/useMeldSellQuote";
import { asName } from "../../funding/top-up-projection";
import { backCashText } from "../../withdraw/sale-back";
import { fmtFiat, isMoneyAmount } from "../../utils/money";
import CashAmount from "../ui/CashAmount.vue";
import DetailRows, { type DetailRow } from "../ui/DetailRows.vue";
import PillButton from "../ui/PillButton.vue";
import RegionRow from "../ui/RegionRow.vue";
import SkeletonRow from "../ui/SkeletonRow.vue";

const props = defineProps<{
  /** The CASH leaving the balance, as typed. */
  amount: string;
  quote: MeldSellQuote | null;
  loading: boolean;
  error: string | null;
  /** The payout country, as an ISO code, and its name. Null while it is still being decided
   *  (geo, or the bounded locale fallback), which the row shows as a skeleton. */
  country: string | null;
  countryName: string | null;
  starting: boolean;
  startError: string | null;
}>();
const emit = defineEmits<{ continue: []; fees: []; region: [] }>();

const rows = computed<DetailRow[]>(() => {
  const q = props.quote;
  if (q === null) return [];
  const { line, fiat } = q;
  const out: DetailRow[] = [
    { label: "You'll receive", value: `≈ ${fmtFiat(line.destinationAmount, fiat)}` },
    { label: "Paid out by", value: asName(line.serviceProvider) },
  ];
  if (isMoneyAmount(line.totalFee) && Number(line.totalFee) > 0) {
    out.push({ label: "Fees", value: fmtFiat(line.totalFee, fiat), fees: true });
  }
  const back = backCashText(q.backCash);
  if (back !== null) out.push({ label: "Back to your balance", value: `≈ ${back}` });
  return out;
});

/** Why part of the amount comes back, or why at this amount it does not. */
const heldBack = computed(() =>
  props.quote !== null && props.quote.backCash > 0n
    ? "Part of the amount is held back in case the price moves while you verify. What the payout does not use comes back to your balance once the provider is paid."
    : "Part of the amount is held back in case the price moves while you verify. At this amount, what the payout does not use is too small to send back.",
);

const canContinue = computed(
  () => props.quote !== null && !props.loading && props.error === null && !props.starting,
);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex flex-col items-center text-center">
      <p class="text-display-l text-fg-primary"><CashAmount :amount="amount" /></p>
      <p class="mt-1 text-body-m text-fg-secondary">From your balance inc. fees</p>
    </div>

    <div class="mt-8 flex flex-col gap-4">
      <!-- Live even while the quote is refused: another country is the way out of one that pays
           out nothing. Undecided (null), the row is a skeleton rather than a provisional region
           the seller could mistake for a decision. -->
      <SkeletonRow v-if="country === null" value-width="w-1/4" />
      <RegionRow
        v-else
        label="Payout country"
        :value="countryName ?? country"
        :country="country"
        @open="emit('region')"
      />
      <div v-if="loading" class="flex flex-col gap-4">
        <SkeletonRow v-for="n in 2" :key="n" />
      </div>
      <DetailRows v-else-if="quote" :rows="rows" @fees="emit('fees')" />
    </div>

    <p v-if="error" class="mt-6 text-body-m text-fg-error" role="alert">{{ error }}</p>
    <template v-else-if="quote">
      <p class="mt-6 text-body-s text-fg-tertiary">
        The provider verifies you and asks where to pay you out. Your balance is only charged once
        that is done, and the amount you receive is confirmed by the provider when it pays out.
      </p>
      <p class="mt-2 text-body-s text-fg-tertiary">{{ heldBack }}</p>
    </template>
    <p v-if="startError" class="mt-4 text-body-m text-fg-error" role="alert">{{ startError }}</p>

    <PillButton class="mt-auto mb-6 w-full" :disabled="!canContinue" @click="emit('continue')">
      {{ starting ? "Starting…" : "Continue" }}
    </PillButton>
  </div>
</template>
