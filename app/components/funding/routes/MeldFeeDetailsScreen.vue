<script setup lang="ts">
// The Fees drill-in behind the pay screen's hero caption: the quoted fee split, its total, the
// charge it is part of, and the effective rate. Read-only; both the toolbar and the bottom button
// return to the pay screen.
import { computed } from "vue";
import { useSessionStore } from "../../../stores/session";
import { fmtFiat, splitFees } from "../../../utils/money";
import DetailRows from "../../ui/DetailRows.vue";
import PillButton from "../../ui/PillButton.vue";

const session = useSessionStore();
const emit = defineEmits<{ back: [] }>();

/**
 * The fee's components, when the quote actually breaks it into some.
 *
 * A quote with no usable network fee has nothing to split: `splitFees` hands the whole total back
 * as the provider's share, and a lone "Provider fee" row would restate the "Total fees" row right
 * below it — the same number twice, with a rule between them implying a sum. Return no components
 * in that case and let the total stand alone.
 *
 * No service fee is charged, so that design row is omitted.
 */
const feeRows = computed(() => {
  const q = session.quoted;
  const split = q ? splitFees(q.fee, q.networkFee) : null;
  if (!q || !split?.network) return [];
  return [
    { label: "Provider fee", value: fmtFiat(split.provider, q.symbol) },
    { label: "Network fee", value: fmtFiat(split.network, q.symbol) },
  ];
});

/** The sum of the split, carried in its own rule-bracketed row. */
const totalRows = computed(() => {
  const q = session.quoted;
  return q?.fee ? [{ label: "Total fees", value: fmtFiat(q.fee, q.symbol) }] : [];
});

/** The charge itself. The split above explains it; this is the number the buyer actually pays. */
const totalCharge = computed(() => {
  const q = session.quoted;
  return q ? fmtFiat(q.send, q.symbol) : null;
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
    <!-- The split, its total, then the charge. The rule above the total is what makes it read as
         a sum, so it only appears when there are components above it to sum. -->
    <template v-if="feeRows.length">
      <DetailRows class="gap-2" :rows="feeRows" muted />
      <hr class="my-2 border-stroke-secondary" />
    </template>

    <DetailRows class="gap-2" :rows="totalRows" muted />

    <hr class="my-2 border-stroke-secondary" />

    <div class="mt-2 flex flex-col gap-1">
      <div class="flex items-center justify-between gap-4">
        <span class="text-paragraph-l text-fg-secondary">You’ll pay</span>
        <span class="text-display-l text-fg-primary">{{ totalCharge }}</span>
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
