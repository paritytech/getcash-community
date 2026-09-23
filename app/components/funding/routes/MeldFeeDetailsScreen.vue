<script setup lang="ts">
// The Fees drill-in behind the pay screen's hero caption: the quoted fee split, its total, the
// charge it is part of, and the effective rate. Read-only; both the toolbar and the bottom button
// return to the pay screen.
import { computed } from "vue";
import { useSessionStore } from "../../../stores/session";
import { fmtFiat, isMoneyAmount, sumMoney } from "../../../utils/money";
import DetailRows from "../../ui/DetailRows.vue";
import PillButton from "../../ui/PillButton.vue";

const session = useSessionStore();
const emit = defineEmits<{ back: [] }>();

/**
 * The fee's components, as the rail reported them and as the app priced the rest.
 *
 * Meld sends each of its own components as its own field, so they are read rather than derived:
 * nothing is inferred by subtracting one component from the total, and a quote carrying no
 * components at all leaves the total to stand on its own.
 *
 * The network row is the exception: it is two fees under one name. The rail's own network fee ends
 * where its delivery does, at native on Asset Hub, and the buyer's money still has a swap and a
 * teleport to go before it is CASH on People — a leg the rail knows nothing about and cannot
 * price, so the store prices it onto the quote as `chainFee` (see `meldChainFeeFiat`). Different
 * legs, but one thing to the buyer: what the networks charged to move their money. No quote has
 * been seen carrying both, the rail's part being absent from every card quote observed so far, but
 * one that did would owe the buyer a single figure rather than two rows sharing a name.
 *
 * The mint row is the PSM tier's alone: the flat cut the PSM takes for turning the delivered
 * stable into CASH (`meldMintFeeFiat`). The pool tier has no such component, so the row is absent
 * there rather than zero.
 */
const feeRows = computed(() => {
  const q = session.quoted;
  if (!q) return [];
  const networkFee = sumMoney(q.networkFee, q.chainFee);
  return [
    { label: "Provider fee", amount: q.transactionFee },
    { label: "Network fee", amount: networkFee === null ? null : String(networkFee) },
    { label: "Mint fee", amount: q.mintFee },
    { label: "Service fee", amount: q.partnerFee },
  ].flatMap(({ label, amount }) =>
    isMoneyAmount(amount) && Number(amount) > 0
      ? [{ label, value: fmtFiat(amount, q.symbol) }]
      : [],
  );
});

/**
 * Everything the split adds up to: the rail's own total plus the funding leg the rail never saw.
 *
 * The rail's `fee` is taken whole rather than re-added from the rows above. A provider that
 * reports a total its named components do not account for has still charged that total, and
 * re-summing the rows would quietly drop the difference; the store says so instead (see
 * `warnOnFeeSplitDrift`). `chainFee` and `mintFee` are ours to add: nothing on the rail's side
 * contains them.
 */
const totalFee = computed(() => {
  const q = session.quoted;
  return q ? sumMoney(q.fee, q.chainFee, q.mintFee) : null;
});

/** The sum of the split, carried in its own rule-bracketed row. */
const totalRows = computed(() => {
  const q = session.quoted;
  const total = totalFee.value;
  return q && total !== null
    ? [{ label: "Total fees", value: fmtFiat(String(total), q.symbol) }]
    : [];
});

/** The charge itself. The split above explains it; this is the number the buyer actually pays. */
const totalCharge = computed(() => {
  const q = session.quoted;
  return q ? fmtFiat(q.send, q.symbol) : null;
});

/** Fiat per CASH net of fees: what the buyer's money actually buys. Net of the same total the
 *  row above carries, so the rate and the split cannot tell different stories. */
const rate = computed(() => {
  const q = session.quoted;
  const cash = Number(session.amountHuman);
  if (!q || !Number.isFinite(cash) || cash <= 0) return null;
  const net = Number(q.send) - (totalFee.value ?? 0);
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
