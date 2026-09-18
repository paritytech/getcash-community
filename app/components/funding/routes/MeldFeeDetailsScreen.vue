<script setup lang="ts">
// The Fees drill-in behind the pay screen's fee row: the quoted fee split, its total, the amount
// those fees add up to, and the effective rate. Read-only; both the toolbar and the bottom button
// return to the screen behind it.
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

const totalFeesRow = computed(() => {
  const q = session.quoted;
  return q?.fee ? [{ label: "Total fees", value: fmtFiat(q.fee, q.symbol) }] : [];
});

/** What the buyer actually sends: the fees are already in it, which is the point of this screen. */
const amountToSend = computed(() => {
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
    <DetailRows class="gap-2" :rows="feeRows" muted />

    <!-- The total is ruled off from its parts above and from the charge below. -->
    <hr class="my-2 border-stroke-secondary" />
    <DetailRows :rows="totalFeesRow" muted />
    <hr class="mt-2 border-stroke-secondary" />

    <div class="mt-4 flex flex-col gap-2">
      <div class="flex items-center justify-between gap-4">
        <span class="text-paragraph-l text-fg-secondary">Amount to send inc. fees</span>
        <span class="text-display-l text-fg-primary">{{ amountToSend }}</span>
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
