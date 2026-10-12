<script setup lang="ts">
// The sale before the seller verifies: the CASH leaving the balance, the payout country, the least
// the provider says it pays out, and how long it takes. The caption opens the fee drill-in once the
// sale is priced. Continue opens the provider's page for KYC; nothing is asked of the balance until
// the provider names where the funds go.
import { computed } from "vue";
import { ChevronRight } from "lucide-vue-next";
import type { MeldSellQuote } from "../../composables/useMeldSellQuote";
import { groupAmountDigits } from "../../utils/cash";
import { fmtFiat } from "../../utils/money";
import CashAmount from "../ui/CashAmount.vue";
import PillButton from "../ui/PillButton.vue";
import RegionRow from "../ui/RegionRow.vue";
import SkeletonBlock from "../ui/SkeletonBlock.vue";

const props = defineProps<{
  method: "card" | "bank";
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

const minPayout = computed(() =>
  props.quote === null ? null : fmtFiat(props.quote.line.destinationAmount, props.quote.fiat),
);

const canContinue = computed(
  () => props.quote !== null && !props.loading && props.error === null && !props.starting,
);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex flex-col items-center gap-1 text-center">
      <p class="text-display-xl text-fg-primary">
        <CashAmount :amount="groupAmountDigits(amount)" />
      </p>
      <button
        v-if="quote"
        type="button"
        class="flex items-center gap-2 text-body-m text-fg-secondary"
        @click="emit('fees')"
      >
        From your balance inc. fees
        <ChevronRight class="size-4" aria-hidden="true" />
      </button>
      <p v-else class="text-body-m text-fg-secondary">From your balance inc. fees</p>
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
      <template v-if="!error">
        <div class="flex items-start justify-between gap-4">
          <span class="text-paragraph-l text-fg-primary">Min. Payout</span>
          <SkeletonBlock v-if="loading || !minPayout" class="mt-1 h-4 w-1/5" />
          <span v-else class="text-heading-m text-fg-primary">{{ minPayout }}</span>
        </div>
        <div class="flex items-start justify-between gap-4">
          <span class="text-paragraph-l text-fg-primary">Arrives</span>
          <span v-if="method === 'card'" class="text-right text-heading-m text-fg-primary">
            A few minutes
          </span>
          <span v-else class="text-right text-heading-m text-fg-primary">
            Your bank can take up to<br />2 days to process
          </span>
        </div>
      </template>
    </div>

    <p v-if="error" class="mt-6 text-body-m text-fg-error" role="alert">{{ error }}</p>
    <p v-if="startError" class="mt-4 text-body-m text-fg-error" role="alert">{{ startError }}</p>

    <PillButton class="mt-auto mb-6 w-full" :disabled="!canContinue" @click="emit('continue')">
      {{ starting ? "Starting…" : "Continue" }}
    </PillButton>
  </div>
</template>
