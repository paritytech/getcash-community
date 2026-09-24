<script setup lang="ts">
// A finished top-up's receipt, opened from the list: what landed, when, and what it cost.
import { computed } from "vue";
import { Plus } from "lucide-vue-next";
import { quoteDetailRows, storedQuoteView } from "../../funding/quote-rows";
import type { FundingTopUp } from "../../funding/top-ups";
import { formatWhenShort } from "../../utils/journey";
import CashAmount from "../ui/CashAmount.vue";
import DetailRows from "../ui/DetailRows.vue";
import PillButton from "../ui/PillButton.vue";

const props = defineProps<{ topUp: FundingTopUp }>();
// fees drills into the breakdown; close leaves the receipt.
const emit = defineEmits<{ fees: []; close: [] }>();

const settled = computed(() => (props.topUp.state.kind === "settled" ? props.topUp.state : null));
const creditedAmount = computed(() => settled.value?.creditedAmount ?? props.topUp.amount);
const when = computed(() => (settled.value === null ? null : formatWhenShort(settled.value.at)));

/** The receipt is only ever reached from the list, so its quote is the record's stored one — the
 *  split included, which is what keeps the fee row's drill-in alive here. */
const rows = computed(() =>
  quoteDetailRows(storedQuoteView(props.topUp.quote, props.topUp.route === "crypto")),
);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="flex flex-col items-center gap-2 text-center">
        <span class="flex size-14 items-center justify-center rounded-full bg-surface-container">
          <Plus class="size-6 text-fg-primary" aria-hidden="true" />
        </span>
        <span>
          <p class="text-display-m text-fg-success">
            <CashAmount sign="+" :amount="creditedAmount" />
          </p>
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
