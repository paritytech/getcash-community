<script setup lang="ts">
// A card or bank rail that routes nothing from the chosen region, top-up or withdrawal: the amount,
// why, the region (still live, as one way out), the other fiat method when the region routes it,
// and crypto. With `range` it is instead a top-up whose amount costs less than the method's minimum
// or more than its maximum there: the bound in CASH, and the ways out are a different amount or
// the bound itself.
import { computed } from "vue";
import type { QuoteOutOfRange } from "../../stores/session";
import { cashAmount } from "../../utils/cash";
import { fmtFiat } from "../../utils/money";
import CashAmount from "../ui/CashAmount.vue";
import DetailRows from "../ui/DetailRows.vue";
import PillButton from "../ui/PillButton.vue";
import RegionRow from "../ui/RegionRow.vue";
import ScreenFrame from "../ui/ScreenFrame.vue";
import TextButton from "../ui/TextButton.vue";

const props = defineProps<{
  direction: "top-up" | "withdraw";
  method: "card" | "bank";
  /** The CASH amount typed. */
  amount: string;
  country: string;
  countryName: string;
  /** In the region's own fiat; the row is left out when null. */
  minimum: { amount: string; fiat: string } | null;
  /** The other fiat method, when the region routes it: the nearer way out than crypto. */
  other: "card" | "bank" | null;
  /** The amount is routed but outside the method's limits: the bound it misses. */
  range?: QuoteOutOfRange | null;
}>();
defineEmits<{
  region: [];
  useCrypto: [];
  useOther: [];
  changeAmount: [];
  /** Continue with the bound, in CASH. */
  useAmount: [cash: string];
}>();

const topUp = computed(() => props.direction === "top-up");
const range = computed(() => props.range ?? null);
const below = computed(() => range.value?.bound === "min");
const payment = computed(() => (props.method === "bank" ? "bank payment" : "card payment"));
const message = computed(() => {
  const r = range.value;
  if (r !== null) {
    if (r.cash === null) {
      return `${below.value ? "Below the minimum" : "Above the maximum"} for ${payment.value} in ${props.countryName}`;
    }
    return below.value
      ? `You need at least ${cashAmount(r.cash)} for ${payment.value} in ${props.countryName}`
      : `You can pay at most ${cashAmount(r.cash)} by ${payment.value} in ${props.countryName}`;
  }
  return `${props.method === "bank" ? "Bank" : "Card"} ${topUp.value ? "transfer" : "payout"} isn't available in this region`;
});
const minRows = computed(() => {
  const r = range.value;
  if (r !== null) {
    const label = below.value ? "Min. payment" : "Max. payment";
    // In CASH, the unit the amount was typed in; the fiat only when it could not be scaled.
    return [
      r.cash === null
        ? { label, value: fmtFiat(r.limit, r.fiat) }
        : { label, value: r.cash, cash: true },
    ];
  }
  return props.minimum
    ? [
        {
          label: topUp.value ? "Min. payment" : "Min. payout",
          value: fmtFiat(props.minimum.amount, props.minimum.fiat),
        },
      ]
    : [];
});
</script>

<template>
  <ScreenFrame>
    <div class="flex shrink-0 flex-col items-center text-center">
      <p class="text-display-xl text-fg-primary"><CashAmount :amount="amount" /></p>
      <p class="mt-1 text-body-s text-fg-error" role="alert">{{ message }}</p>
    </div>

    <div class="mt-6 flex flex-col gap-4">
      <RegionRow
        :label="topUp ? 'Payment country' : 'Payout country'"
        :value="countryName"
        :country="country"
        @open="$emit('region')"
      />
      <DetailRows :rows="minRows" />
    </div>

    <template #actions>
      <div v-if="range" class="flex flex-col gap-4">
        <PillButton variant="secondary" class="w-full" @click="$emit('changeAmount')">
          Change amount
        </PillButton>
        <PillButton v-if="range.cash" class="w-full" @click="$emit('useAmount', range.cash)">
          Continue with {{ cashAmount(range.cash) }}
        </PillButton>
      </div>
      <div v-else class="flex flex-col items-center gap-2">
        <PillButton class="w-full" @click="$emit('useCrypto')">Use crypto</PillButton>
        <TextButton v-if="other" @click="$emit('useOther')">Use {{ other }} instead</TextButton>
      </div>
    </template>
  </ScreenFrame>
</template>
