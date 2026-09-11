<script setup lang="ts">
// A finished top-up's receipt, opened from the list: what landed, when, and what it cost.
import { computed } from "vue";
import { Plus } from "lucide-vue-next";
import { quoteDetailRows, type QuoteView } from "../../funding/quote-rows";
import type { FundingTopUp } from "../../funding/top-ups";
import { formatWhenShort } from "../../utils/journey";
import DetailRows from "../ui/DetailRows.vue";
import PillButton from "../ui/PillButton.vue";

const props = defineProps<{ topUp: FundingTopUp }>();
// fees drills into the breakdown; close leaves the receipt.
const emit = defineEmits<{ fees: []; close: [] }>();

const settled = computed(() => (props.topUp.state.kind === "settled" ? props.topUp.state : null));
const creditedAmount = computed(() => settled.value?.creditedAmount ?? props.topUp.amount);
const when = computed(() => (settled.value === null ? null : formatWhenShort(settled.value.at)));

/**
 * The receipt's own quote is always the list's stored one: this screen is only ever reached from
 * the top-ups list, never from a live request, so the fee row never drills in.
 */
const rows = computed(() => {
  const stored = props.topUp.quote;
  if (!stored) return [];
  const view: QuoteView = {
    amount: stored.amount,
    symbol: stored.symbol,
    ...(stored.fee === undefined ? {} : { fee: stored.fee }),
    crypto: props.topUp.route === "crypto",
    live: false,
  };
  return quoteDetailRows(view);
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="flex flex-col items-center gap-2 text-center">
        <span class="flex size-14 items-center justify-center rounded-full bg-surface-container">
          <Plus class="size-6 text-fg-primary" aria-hidden="true" />
        </span>
        <span>
          <p class="text-display-m text-fg-success">+{{ creditedAmount }} $CASH</p>
          <p v-if="when" class="text-paragraph-l text-fg-secondary">{{ when }}</p>
        </span>
      </div>

      <DetailRows v-if="rows.length" class="mt-6" :rows="rows" @fees="emit('fees')" />
    </div>

    <PillButton variant="tertiary" class="mt-6 mb-6 w-full" @click="emit('close')">
      Close
    </PillButton>
  </div>
</template>
