<script setup lang="ts">
// The sale before the seller verifies: the CASH leaving the balance, the payout country, the least
// the provider says it pays out, and how long it takes. The caption opens the fee drill-in once the
// sale is priced. Continue opens the provider's page for KYC; nothing is asked of the balance until
// the provider names where the funds go. A price that could not be had takes the whole screen, and
// a region this method does not pay out in shows the view the top-up rails share.
import { computed } from "vue";
import { ChevronRight } from "lucide-vue-next";
import type { MeldSellQuote } from "../../composables/useMeldSellQuote";
import { groupAmountDigits } from "../../utils/cash";
import { fmtFiat } from "../../utils/money";
import MethodUnavailable from "../funding/MethodUnavailable.vue";
import CashAmount from "../ui/CashAmount.vue";
import ErrorState from "../ui/ErrorState.vue";
import PillButton from "../ui/PillButton.vue";
import RegionRow from "../ui/RegionRow.vue";
import SkeletonBlock from "../ui/SkeletonBlock.vue";

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
  /** The payout country, as an ISO code, and its name. */
  country: string;
  countryName: string;
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
  changeAmount: [];
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
  <MethodUnavailable
    v-if="unrouted"
    direction="withdraw"
    :method="method"
    :amount="groupAmountDigits(amount)"
    :country="country"
    :country-name="countryName"
    :minimum="minimum"
    :other="other"
    @region="emit('region')"
    @use-crypto="emit('useCrypto')"
    @use-other="emit('useOther')"
  />

  <div v-else-if="rateFailed" class="flex min-h-0 flex-1 flex-col">
    <ErrorState
      v-if="rateFailures < 2"
      class="my-auto"
      title="Couldn't get the rate"
      body="This is usually temporary. Try again in a moment"
    />
    <ErrorState
      v-else
      class="my-auto"
      title="Still not working"
      body="Try a different amount, or send to a crypto wallet instead"
    />
    <PillButton v-if="rateFailures < 2" class="mb-6 w-full" @click="emit('retry')">
      Try again
    </PillButton>
    <div v-else class="mb-6 flex flex-col gap-4">
      <PillButton variant="secondary" class="w-full" @click="emit('useCrypto')">
        Use crypto
      </PillButton>
      <PillButton class="w-full" @click="emit('changeAmount')">Change amount</PillButton>
    </div>
  </div>

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
      <RegionRow
        label="Payout country"
        :value="countryName"
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
