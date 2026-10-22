<script setup lang="ts">
// The Fees drill-in behind the summary's hero caption: the amount and its worth before fees, the
// quote's split, its total, and what lands with the rate it implies. Read-only; both the toolbar
// and the bottom button return to the summary.
import { computed } from "vue";
import type { WithdrawFeeView } from "../../withdraw/offers";
import { groupAmountDigits } from "../../utils/cash";
import DetailRows from "../ui/DetailRows.vue";
import PillButton from "../ui/PillButton.vue";
import ReceiveRow from "./ReceiveRow.vue";

const props = defineProps<{
  /** The CASH leaving the balance, as typed. */
  amount: string;
  fees: WithdrawFeeView;
}>();
const emit = defineEmits<{ back: [] }>();

const headRows = computed(() => [
  { label: "You'll withdraw", value: groupAmountDigits(props.amount), cash: true },
  ...(props.fees.equivalent === undefined
    ? []
    : [{ label: "Equivalent", value: props.fees.equivalent }]),
]);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <DetailRows class="gap-2" :rows="headRows" muted />

    <!-- The split, then its total; the rules bracket the sum like a ledger. -->
    <template v-if="fees.rows.length">
      <hr class="my-2 border-stroke-secondary" />
      <DetailRows class="gap-2" :rows="fees.rows" muted />
    </template>
    <template v-if="fees.total !== undefined">
      <hr class="my-2 border-stroke-secondary" />
      <DetailRows class="gap-2" :rows="[{ label: 'Total fees', value: fees.total }]" muted />
    </template>

    <hr class="my-2 border-stroke-secondary" />

    <ReceiveRow :receive="fees.receive" :rate="fees.rate ?? null" />

    <PillButton variant="tertiary" class="mt-auto mb-6 w-full" @click="emit('back')">
      Back
    </PillButton>
  </div>
</template>
