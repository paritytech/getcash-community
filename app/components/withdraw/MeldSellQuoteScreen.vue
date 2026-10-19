<script setup lang="ts">
// The sale before the seller verifies: the CASH leaving the balance, the payout country, the least
// the provider says it pays out, and how long it takes. The caption opens the fee drill-in once the
// sale is priced. Continue opens the provider's page for KYC; nothing is asked of the balance until
// the provider names where the funds go. A price that could not be had takes the whole screen, and
// a region this method does not pay out in shows the view the top-up rails share. Both failure
// screens are the ones the top-up rails show.
import { computed } from "vue";
import { ChevronRight } from "lucide-vue-next";
import type { MeldSellQuote } from "../../composables/useMeldSellQuote";
import { groupAmountDigits } from "../../utils/cash";
import { fmtFiat } from "../../utils/money";
import MethodUnavailable from "../funding/MethodUnavailable.vue";
import CashAmount from "../ui/CashAmount.vue";
import PillButton from "../ui/PillButton.vue";
import RateErrorScreen from "../ui/RateErrorScreen.vue";
import RegionRow from "../ui/RegionRow.vue";
import SkeletonBlock from "../ui/SkeletonBlock.vue";
import SkeletonRow from "../ui/SkeletonRow.vue";

const props = defineProps<{
  method: "card" | "bank";
  /** The other fiat method, when the country pays out by it. */
  other: "card" | "bank" | null;
  /** The CASH leaving the balance, as typed. */
  amount: string;
  quote: MeldSellQuote | null;
  loading: boolean;
  error: string | null;
  errorKind: "unrouted" | "rate" | null;
  /** Price failures in a row: the second stops offering another try. */
  rateFailures: number;
  /** In the country's fiat, when the catalog prices one. */
  minimum: { amount: string; fiat: string } | null;
  /** The payout country, as an ISO code, and its name. Null while it is still being decided
   *  (geo, or the bounded locale fallback), which the row shows as a skeleton. */
  country: string | null;
  countryName: string | null;
  starting: boolean;
  startError: string | null;
}>();
const emit = defineEmits<{
  continue: [];
  fees: [];
  region: [];
  useOther: [];
  retry: [];
  useCrypto: [];
}>();

const rateFailed = computed(() => !props.loading && props.errorKind === "rate");
const unrouted = computed(() => !props.loading && props.errorKind === "unrouted");

const minPayout = computed(() =>
  props.quote === null ? null : fmtFiat(props.quote.line.destinationAmount, props.quote.fiat),
);

const canContinue = computed(
  () => props.quote !== null && !props.loading && props.error === null && !props.starting,
);
</script>

<template>
  <!-- A refusal is only ever for a decided region: pricing waits for it (the route). -->
  <MethodUnavailable
    v-if="unrouted && country !== null"
    direction="withdraw"
    :method="method"
    :amount="groupAmountDigits(amount)"
    :country="country"
    :country-name="countryName ?? country"
    :minimum="minimum"
    :other="other"
    @region="emit('region')"
    @use-crypto="emit('useCrypto')"
    @use-other="emit('useOther')"
  />

  <RateErrorScreen
    v-else-if="rateFailed"
    :failures="rateFailures"
    @retry="emit('retry')"
    @change-country="emit('region')"
    @use-crypto="emit('useCrypto')"
  />

  <div v-else class="flex min-h-0 flex-1 flex-col">
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
      <!-- Live even while the region is refused: another country is the way out of it. Undecided
           (null), the row is a skeleton rather than a provisional region the seller could mistake
           for a decision. -->
      <SkeletonRow v-if="country === null" value-width="w-1/4" />
      <RegionRow
        v-else
        label="Payout country"
        :value="countryName ?? country"
        :country="country"
        @open="emit('region')"
      />
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
    </div>

    <p v-if="startError" class="mt-4 text-body-m text-fg-error" role="alert">{{ startError }}</p>

    <PillButton class="mt-auto w-full" :disabled="!canContinue" @click="emit('continue')">
      {{ starting ? "Starting…" : "Continue" }}
    </PillButton>
    <PoweredBy class="mt-3 mb-4" provider="Meld" />
  </div>
</template>
