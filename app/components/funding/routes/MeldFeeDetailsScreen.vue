<script setup lang="ts">
// The Fees drill-in behind the pay screen's fee row: the quoted fee split, its total, and the
// effective rate. Read-only; both the toolbar and the bottom button return to the pay screen.
import { computed } from "vue";
import { useSessionStore } from "../../../stores/session";
import { fmtFiat, splitFees } from "../../../utils/money";
import DetailRows from "../../ui/DetailRows.vue";
import PillButton from "../../ui/PillButton.vue";

const session = useSessionStore();
const emit = defineEmits<{ back: [] }>();

/** No service fee is charged, so that design row is omitted. */
const feeRows = computed(() => {
  const q = session.quoted;
  const split = q ? splitFees(q.fee, q.networkFee) : null;
  if (!q || !split) return [];
  const rows = [{ label: "Provider fee", value: fmtFiat(split.provider, q.symbol) }];
  if (split.network) rows.push({ label: "Network fee", value: fmtFiat(split.network, q.symbol) });
  return rows;
});

const totalFees = computed(() => {
  const q = session.quoted;
  return q?.fee ? fmtFiat(q.fee, q.symbol) : null;
});

/** Fiat per CASH net of fees: what the buyer's money actually buys. */
const rate = computed(() => {
  const q = session.quoted;
  const cash = Number(session.amountHuman);
  if (!q || !Number.isFinite(cash) || cash <= 0) return null;
  const net = Number(q.send) - Number(q.fee ?? 0);
  if (!Number.isFinite(net) || net <= 0) return null;
  return `1 $CASH ≈ ${fmtFiat((net / cash).toFixed(2), q.symbol)}`;
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <DetailRows class="gap-2" :rows="feeRows" muted />

    <hr class="my-4 border-stroke-secondary" />

    <div class="flex flex-col gap-1">
      <div class="flex items-center justify-between gap-4">
        <span class="text-paragraph-l text-fg-secondary">Total fees</span>
        <span class="text-display-l text-fg-primary">{{ totalFees }}</span>
      </div>
      <div v-if="rate" class="flex items-baseline justify-between gap-4">
        <span class="text-paragraph-l text-fg-secondary">Rate</span>
        <span class="text-paragraph-l text-fg-secondary">{{ rate }}</span>
      </div>
    </div>

    <PillButton variant="tertiary" class="mt-auto mb-6 w-full" @click="emit('back')">
      Back
    </PillButton>
  </div>
</template>
