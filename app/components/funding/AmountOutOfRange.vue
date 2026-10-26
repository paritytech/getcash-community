<script setup lang="ts">
// An amount a quote refused for falling outside a bound, top-up or withdrawal: the amount, why in
// red under it, the region when the method has one (still live, as one way out), the bound, and
// the ways on: a different amount, or the bound itself.
import type { OutOfRangeWords } from "../../funding/out-of-range";
import { cashAmount } from "../../utils/cash";
import CashAmount from "../ui/CashAmount.vue";
import DetailRows from "../ui/DetailRows.vue";
import PillButton from "../ui/PillButton.vue";
import RegionRow from "../ui/RegionRow.vue";
import ScreenFrame from "../ui/ScreenFrame.vue";

defineProps<{
  /** The CASH amount typed, grouped. */
  amount: string;
  words: OutOfRangeWords;
  /** The region the quote was for, when the method has one. */
  region?: { label: string; value: string; country: string } | null;
}>();
defineEmits<{
  region: [];
  changeAmount: [];
  /** Continue with the bound, in CASH. */
  useAmount: [cash: string];
}>();
</script>

<template>
  <ScreenFrame>
    <div class="flex shrink-0 flex-col items-center text-center">
      <p class="text-display-xl text-fg-primary"><CashAmount :amount="amount" /></p>
      <p class="mt-1 text-body-s text-fg-error" role="alert">{{ words.message }}</p>
    </div>

    <div class="mt-6 flex flex-col gap-4">
      <RegionRow
        v-if="region"
        :label="region.label"
        :value="region.value"
        :country="region.country"
        @open="$emit('region')"
      />
      <DetailRows :rows="words.rows" />
    </div>

    <template #actions>
      <div class="flex flex-col gap-4">
        <PillButton variant="secondary" class="w-full" @click="$emit('changeAmount')">
          Change amount
        </PillButton>
        <PillButton v-if="words.bound" class="w-full" @click="$emit('useAmount', words.bound)">
          Continue with {{ cashAmount(words.bound) }}
        </PillButton>
      </div>
    </template>
  </ScreenFrame>
</template>
