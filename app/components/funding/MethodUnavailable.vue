<script setup lang="ts">
// A card or bank rail that routes nothing from the chosen region, or whose providers there are all
// failing right now, top-up or withdrawal: the amount, why, the region (still live, as one way
// out), and crypto. An amount the method takes but outside its limits is `AmountOutOfRange`'s.
import { Info } from "lucide-vue-next";
import { computed } from "vue";
import { inCountry } from "~~/lib/supported";
import { fmtFiat } from "../../utils/money";
import CashAmount from "../ui/CashAmount.vue";
import DetailRows from "../ui/DetailRows.vue";
import PillButton from "../ui/PillButton.vue";
import RegionRow from "../ui/RegionRow.vue";
import ScreenFrame from "../ui/ScreenFrame.vue";

const props = defineProps<{
  direction: "top-up" | "withdraw";
  method: "card" | "bank";
  /** The CASH amount typed. */
  amount: string;
  country: string;
  countryName: string;
  /** In the region's own fiat; the row is left out when null. */
  minimum: { amount: string; fiat: string } | null;
  /** The region routes the method, but its providers are failing right now. */
  temporarily?: boolean;
}>();
defineEmits<{
  region: [];
  useCrypto: [];
}>();

const topUp = computed(() => props.direction === "top-up");
const message = computed(
  () =>
    `${props.method === "bank" ? "Bank" : "Card"} ${topUp.value ? "transfer" : "payout"} isn't available ${inCountry(props.countryName)}${props.temporarily ? " right now" : ""}`,
);
const hint = computed(() => {
  const elsewhere = topUp.value ? "pay from another country" : "get paid in another country";
  return props.temporarily
    ? `Try again later, or change it above if you ${elsewhere}.`
    : `${topUp.value ? "Paying from" : "Getting paid in"} another country? Change it above.`;
});
// A minimum means nothing while no provider answers.
const minRows = computed(() =>
  props.minimum && !props.temporarily
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
  <ScreenFrame>
    <div class="flex shrink-0 flex-col items-center text-center">
      <p class="text-display-xl text-fg-primary"><CashAmount :amount="amount" /></p>
      <p class="mt-1 text-body-s text-fg-error" role="alert">{{ message }}</p>
    </div>

    <div class="mt-6 flex flex-col gap-4">
      <div class="flex flex-col gap-4">
        <RegionRow
          :label="topUp ? 'Payment country' : 'Payout country'"
          :value="countryName"
          :country="country"
          @open="$emit('region')"
        />
        <div class="flex items-center gap-3 rounded-medium bg-surface-container px-4 py-3">
          <Info class="size-4 shrink-0 text-fg-secondary" aria-hidden="true" />
          <p class="text-body-s text-fg-primary">{{ hint }}</p>
        </div>
      </div>
      <DetailRows :rows="minRows" />
    </div>

    <template #actions>
      <div class="flex flex-col items-center gap-2">
        <PillButton class="w-full" @click="$emit('useCrypto')">Use crypto</PillButton>
      </div>
    </template>
  </ScreenFrame>
</template>
