<script setup lang="ts">
// The withdrawal's journey: from the payment out of the balance to the funds at the destination.
// Everything shown is read from the record; the actions go back to the route.
import { computed } from "vue";
import { Check, RefreshCcw, X } from "lucide-vue-next";
import { depositTokenOf, recordedRoute } from "@getsome/funding";
import { formatBaseUnits, sellAmountOf } from "@getsome/meld";
import { useFundingProgressClock } from "../../composables/useFundingProgressClock";
import {
  paymentTaken,
  saleAwaitingDeposit,
  type WithdrawalRecord,
} from "../../funding/requests/model";
import { asName } from "../../funding/top-up-projection";
import { formatWhenShort, shortRef } from "../../utils/journey";
import { fmtFiat } from "../../utils/money";
import { shortAddress } from "../../withdraw/destinations";
import { withdrawalFailureText } from "../../withdraw/failure-copy";
import {
  SALE_KYC_LABEL,
  WITHDRAWAL_JOURNEY_LABELS,
  withdrawalJourneyDone,
  withdrawalProgress,
  withdrawalProgressProfile,
} from "../../withdraw/progress";
import FundingJourneyTimeline from "../funding/progress/FundingJourneyTimeline.vue";
import CashAmount from "../ui/CashAmount.vue";
import DetailRows, { type DetailRow } from "../ui/DetailRows.vue";
import PillButton from "../ui/PillButton.vue";

const props = defineProps<{
  record: WithdrawalRecord;
  /** A line the record does not carry: a refused cancel, a retry that could not start. */
  notice: string | null;
  busy: boolean;
  /** What the pool would land for a held withdrawal, formatted; null until quoted. */
  poolFigure?: string | null;
}>();
const emit = defineEmits<{ cancel: []; retry: []; pool: []; close: [] }>();

const now = useFundingProgressClock(
  () => withdrawalProgressProfile(props.record.rail.provider).cadenceMs,
);
const progress = computed(() => withdrawalProgress(props.record, now.value));
const done = computed(() => withdrawalJourneyDone(props.record));

const status = computed(() => props.record.status);
const sent = computed(() => status.value.kind === "sent");
const failure = computed(() => props.record.failure ?? null);
const sideExit = computed(
  () =>
    status.value.kind === "failed" ||
    status.value.kind === "expired" ||
    status.value.kind === "cancelled",
);

/** The design names the expired step itself, not "<stage> failed". */
const failedLabel = computed(() => {
  if (status.value.kind === "expired") return "Expired";
  if (status.value.kind === "cancelled") return "Cancelled";
  if (failure.value?.step !== "payment") return null;
  // A sale that ended before its balance was asked had no payment to fail.
  const unasked = props.record.sale !== undefined && props.record.payment.requestedAt === undefined;
  return unasked ? "Sale ended" : "Payment failed";
});

const sentWhen = computed(() =>
  status.value.kind === "sent" ? formatWhenShort(status.value.at) : null,
);

/** The one line under the stepper. */
const message = computed(() => {
  if (props.notice) return props.notice;
  if (status.value.kind === "cancelled") return "This withdrawal was cancelled.";
  if (failure.value) return withdrawalFailureText(failure.value);
  // The funding product is approved without a sheet, so a requested payment is processing.
  if (status.value.kind === "awaiting-payment") {
    // A sale asks the balance only once the provider knows where the funds go.
    if (saleAwaitingDeposit(props.record)) return SALE_KYC_LABEL;
    return props.record.payment.requestedAt === undefined
      ? "Waiting for your payment"
      : "Your payment is being processed";
  }
  if (status.value.kind === "sent") {
    if (props.record.route !== "crypto") {
      return props.record.route === "bank" ? "Paid out to your bank" : "Paid out to your card";
    }
    return `Sent to ${shortAddress(props.record.destination.address)}`;
  }
  return progress.value.view.label;
});

/** What a sale left over once the provider was paid, and where it is. A sale that ended unpaid
 *  sends everything back, which its failure already says, so only the arrival is added. A way
 *  home that failed past the worker's retries says so, for support. */
const residueNote = computed(() => {
  const residue = props.record.residue;
  if (residue === undefined) return null;
  if (residue.stuck === true) {
    return "What was left could not come back to your balance on its own. Contact support with your reference.";
  }
  // In the token the sale sold, shown to the sale's decimals; a remainder below them is not worth
  // a line.
  const token = depositTokenOf(recordedRoute(props.record.handoff));
  const shown = residue.amount === undefined ? 0n : sellAmountOf(token, BigInt(residue.amount));
  const symbol = props.record.sale?.token ?? token.symbol;
  const amount = shown === 0n ? null : `${formatBaseUnits(token, shown)} ${symbol}`;
  if (!residue.returning) {
    return amount === null
      ? null
      : `The ${amount} left over was too little to send back, and stays with this withdrawal.`;
  }
  if (residue.whole === true || amount === null) {
    return residue.returned ? "Your funds came back to your balance as CASH." : null;
  }
  return residue.returned
    ? `The ${amount} left over came back to your balance as CASH.`
    : `The ${amount} left over is on its way back to your balance.`;
});

/** A sale's payout as quoted and its reference, the id support finds the order by on both sides:
 *  the adapter files it with Meld as the session's external id. */
const saleRows = computed<DetailRow[]>(() => {
  const sale = props.record.sale;
  if (sale === undefined) return [];
  return [
    {
      label: "Payout",
      value: `≈ ${fmtFiat(sale.quotedPayout, sale.fiat)} via ${asName(sale.serviceProvider)}`,
    },
    { label: "Reference", value: shortRef(sale.fundingRequestId), copy: sale.fundingRequestId },
  ];
});

/** Cancel is offered only while nothing was paid and the host has nothing in hand. */
const canCancel = computed(
  () => status.value.kind === "awaiting-payment" && !paymentTaken(props.record),
);
const canRetry = computed(() => status.value.kind === "failed" && status.value.recoverable);
/** The pool is offered only where waiting cannot help: the PSM refused with room for the redeem. */
const canSwitchToPool = computed(
  () => status.value.kind === "failed" && failure.value?.kind === "held",
);
</script>

<template>
  <div class="-mx-4 flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-6">
    <div class="flex flex-col items-center text-center">
      <span
        class="flex size-14 items-center justify-center rounded-full"
        :class="sideExit ? 'journey-hero-failed' : 'bg-surface-container'"
      >
        <X v-if="sideExit" class="size-6 text-fg-error" aria-hidden="true" />
        <Check v-else-if="sent" class="size-6 text-fg-primary" aria-hidden="true" />
        <RefreshCcw v-else class="size-6 text-fg-primary" aria-hidden="true" />
      </span>
      <p
        class="mt-2 text-display-m"
        :class="sent ? 'text-fg-success' : sideExit ? 'text-fg-secondary' : 'text-fg-primary'"
      >
        <CashAmount :amount="record.amountHuman" />
      </p>
      <p v-if="sentWhen" class="text-paragraph-l text-fg-secondary">{{ sentWhen }}</p>
    </div>

    <div class="mt-6 flex flex-1 flex-col gap-6">
      <FundingJourneyTimeline
        :progress="progress"
        :labels="WITHDRAWAL_JOURNEY_LABELS"
        :completed-steps="done"
        :message="message"
        :failed-label="failedLabel"
      />
      <p v-if="residueNote" class="text-body-s text-fg-secondary">{{ residueNote }}</p>
      <DetailRows v-if="saleRows.length > 0" :rows="saleRows" muted />

      <div v-if="canRetry" class="mt-auto flex flex-col gap-3">
        <PillButton :disabled="busy" @click="emit('retry')">Try again</PillButton>
        <PillButton
          v-if="canSwitchToPool"
          variant="tertiary"
          :disabled="busy || !poolFigure"
          @click="emit('pool')"
        >
          Sell on the pool{{ poolFigure ? ` for about ${poolFigure}` : "" }}
        </PillButton>
      </div>
      <!-- Cancel and retry never show together: cancel is for an unpaid request, retry for a
           failed one. -->
      <PillButton
        v-if="canCancel"
        variant="tertiary"
        class="mt-auto"
        :disabled="busy"
        @click="emit('cancel')"
      >
        Cancel withdrawal
      </PillButton>
      <PillButton
        v-if="sent || (sideExit && !canRetry)"
        variant="tertiary"
        class="mt-auto"
        @click="emit('close')"
      >
        Close
      </PillButton>
    </div>
  </div>
</template>

<style scoped>
/* The failed hero circle binds the red-alpha primitive in the design; no semantic token covers it. */
.journey-hero-failed {
  background: var(--palette-red-alpha-24);
}
</style>
