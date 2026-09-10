<script setup lang="ts">
// The Fees drill-in behind the pay screen's fee row: the quoted fee split, its total, and the
// effective rate. Read-only; both the toolbar and the bottom button return to the pay screen.
import { computed } from "vue";
import { useSessionStore } from "../../../stores/session";
import { fmtFiat } from "../../../utils/money";

const session = useSessionStore();
const emit = defineEmits<{ back: [] }>();

/** Meld splits out only the network fee; the remainder is the provider's. No service fee is
 *  charged, so that design row is omitted. */
const feeRows = computed(() => {
  const q = session.quoted;
  const total = Number(q?.fee ?? Number.NaN);
  if (!q || !Number.isFinite(total)) return [];
  const network = Number(q.networkFee ?? Number.NaN);
  if (!Number.isFinite(network) || network <= 0 || network > total) {
    return [{ label: "Provider fee", value: fmtFiat(String(total), q.symbol) }];
  }
  return [
    { label: "Provider fee", value: fmtFiat((total - network).toFixed(2), q.symbol) },
    { label: "Network fee", value: fmtFiat(String(network), q.symbol) },
  ];
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
    <div class="flex flex-col gap-2">
      <div
        v-for="row in feeRows"
        :key="row.label"
        class="flex items-baseline justify-between gap-4"
      >
        <span class="text-paragraph-l text-fg-secondary">{{ row.label }}</span>
        <span class="text-heading-m text-fg-primary">{{ row.value }}</span>
      </div>
    </div>

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

    <button
      type="button"
      class="mt-auto mb-6 h-12 w-full rounded-full bg-action-tertiary text-label-l font-semibold text-fg-primary transition-colors hover:bg-action-tertiary-hover"
      @click="emit('back')"
    >
      Back
    </button>
  </div>
</template>
