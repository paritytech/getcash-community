<script setup lang="ts">
// The sale before the seller verifies: the CASH leaving the balance, the payout country, and what
// the provider says it pays out for the exact figure the key will send. Continue opens the
// provider's page for KYC; nothing is asked of the balance until the provider names where the
// funds go.
import { computed } from "vue";
import type { MeldSellQuote } from "../../composables/useMeldSellQuote";
import { fmtFiat, isMoneyAmount } from "../../utils/money";
import CashAmount from "../ui/CashAmount.vue";
import DetailRows, { type DetailRow } from "../ui/DetailRows.vue";
import PillButton from "../ui/PillButton.vue";
import RegionRow from "../ui/RegionRow.vue";
import SkeletonBlock from "../ui/SkeletonBlock.vue";

const props = defineProps<{
  /** The CASH leaving the balance, as typed. */
  amount: string;
  quote: MeldSellQuote | null;
  loading: boolean;
  error: string | null;
  /** The payout country, as an ISO code, and its name. */
  country: string;
  countryName: string;
  starting: boolean;
  startError: string | null;
}>();
const emit = defineEmits<{ continue: []; fees: []; region: [] }>();

/** The provider's name as a person would write it: "TRANSAK" reads as "Transak". */
function providerName(code: string): string {
  return code
    .toLowerCase()
    .split(/[_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const rows = computed<DetailRow[]>(() => {
  const q = props.quote;
  if (q === null) return [];
  const { line, fiat } = q;
  const out: DetailRow[] = [
    { label: "You'll receive", value: `≈ ${fmtFiat(line.destinationAmount, fiat)}` },
    { label: "Paid out by", value: providerName(line.serviceProvider) },
  ];
  if (isMoneyAmount(line.totalFee) && Number(line.totalFee) > 0) {
    out.push({ label: "Fees", value: fmtFiat(line.totalFee, fiat), fees: true });
  }
  return out;
});

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
           out nothing. -->
      <RegionRow
        label="Payout country"
        :value="countryName"
        :country="country"
        @open="emit('region')"
      />
      <div v-if="loading" class="flex flex-col gap-4">
        <div v-for="n in 2" :key="n" class="flex h-6 items-center justify-between">
          <SkeletonBlock class="h-4 w-2/5" />
          <SkeletonBlock class="h-4 w-1/5" />
        </div>
      </div>
      <DetailRows v-else-if="quote" :rows="rows" @fees="emit('fees')" />
    </div>

    <p v-if="error" class="mt-6 text-body-m text-fg-error" role="alert">{{ error }}</p>
    <p v-else-if="quote" class="mt-6 text-body-s text-fg-tertiary">
      The provider verifies you and asks where to pay you out. Your balance is only charged once
      that is done, and the amount you receive is confirmed by the provider when it pays out.
    </p>
    <p v-if="startError" class="mt-4 text-body-m text-fg-error" role="alert">{{ startError }}</p>

    <PillButton class="mt-auto mb-6 w-full" :disabled="!canContinue" @click="emit('continue')">
      {{ starting ? "Starting…" : "Continue" }}
    </PillButton>
  </div>
</template>
