<script setup lang="ts">
// A card or bank rail that routes nothing from the chosen region, top-up or withdrawal: the amount,
// why, the region (still live, as one way out), the other fiat method when the region routes it,
// and crypto.
import { computed } from "vue";
import { fmtFiat } from "../../utils/money";
import CashAmount from "../ui/CashAmount.vue";
import DetailRows from "../ui/DetailRows.vue";
import PillButton from "../ui/PillButton.vue";
import RegionRow from "../ui/RegionRow.vue";
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
}>();
defineEmits<{ region: []; useCrypto: []; useOther: [] }>();

const topUp = computed(() => props.direction === "top-up");
const message = computed(
  () =>
    `${props.method === "bank" ? "Bank" : "Card"} ${topUp.value ? "transfer" : "payout"} isn't available in this region`,
);
const minRows = computed(() =>
  props.minimum
    ? [
        {
          label: topUp.value ? "Min. payment" : "Min. payout",
          value: fmtFiat(props.minimum.amount, props.minimum.fiat),
        },
      ]
    : [],
);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
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

    <div class="mt-auto mb-6 flex shrink-0 flex-col items-center gap-2">
      <PillButton class="w-full" @click="$emit('useCrypto')">Use crypto</PillButton>
      <TextButton v-if="other" @click="$emit('useOther')">Use {{ other }} instead</TextButton>
    </div>
  </div>
</template>
