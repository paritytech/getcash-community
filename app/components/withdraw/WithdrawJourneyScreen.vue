<script setup lang="ts">
// The withdrawal's journey: from the payment out of the balance to the funds at the destination.
// Everything shown is read from the record; the actions go back to the route.
import { computed } from "vue";
import { ArrowUpRight, RefreshCcw, X } from "lucide-vue-next";
import { formatSourceAmount, SOURCE_CONFIG_BY_ID } from "@getsome/chainflip";
import { formatBaseUnits, sellAmountOf, SELL_TOKEN } from "@getsome/meld";
import { useFundingProgressClock } from "../../composables/useFundingProgressClock";
import {
  paymentTaken,
  saleAwaitingDeposit,
  type WithdrawalRecord,
} from "../../funding/requests/model";
import { asName } from "../../funding/top-up-projection";
import { formatWhenShort, shortRef } from "../../utils/journey";
import { fmtFiat } from "../../utils/money";
import { shortDestinationAddress } from "../../withdraw/destinations";
import { sourceIdFor } from "~~/lib/config";
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
}>();
const emit = defineEmits<{ cancel: []; retry: []; close: []; "return-funds": [] }>();

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

/** What the quote said would land, formatted in the destination asset. Nothing for the direct
 *  rail, which stores no channel and no promised figure. */
const sentEgress = computed(() => {
  const egress = props.record.handoff.channel?.expectedEgress;
  if (egress === undefined) return null;
  const { chain, asset } = props.record.destination;
  const id = sourceIdFor(chain, asset);
  const config = id === undefined ? undefined : SOURCE_CONFIG_BY_ID.get(id);
  if (config === undefined) return null;
  try {
    return `${formatSourceAmount(config, egress, { maxDecimals: 6 })} ${asset}`;
  } catch {
    return null;
  }
});

/** The one line under the stepper: the endings and the payment wait speak, the design's
 *  in-flight frames carry no ribbon. */
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
  // The design's in-flight crypto frames carry no ribbon, and crypto's sent ending trades the
  // stepper for the summary rows; a sale keeps the stepper and speaks the journey's line.
  if (props.record.route === "crypto") return null;
  if (status.value.kind === "sent") {
    return props.record.route === "bank" ? "Paid out to your bank" : "Paid out to your card";
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
  // Shown to the sale's decimals; a remainder below them is not worth a line.
  const shown = residue.amount === undefined ? 0n : sellAmountOf(BigInt(residue.amount));
  const amount = shown === 0n ? null : `${formatBaseUnits(SELL_TOKEN, shown)} ${SELL_TOKEN.symbol}`;
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
/** A refund leaves the DOT on the withdrawal's own key: the design walks it into a wallet. */
const refunded = computed(
  () => status.value.kind === "failed" && failure.value?.kind === "refunded",
);
const canRetry = computed(
  () => status.value.kind === "failed" && status.value.recoverable && !refunded.value,
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
        <ArrowUpRight v-else-if="sent" class="size-6 text-fg-primary" aria-hidden="true" />
        <RefreshCcw v-else class="size-6 text-fg-primary" aria-hidden="true" />
      </span>
      <p class="mt-2 text-display-m" :class="sideExit ? 'text-fg-secondary' : 'text-fg-primary'">
        <CashAmount :amount="record.amountHuman" :sign="sent ? '-' : ''" />
      </p>
      <p v-if="sentWhen" class="text-paragraph-l text-fg-secondary">{{ sentWhen }}</p>
    </div>

    <div class="mt-6 flex flex-1 flex-col gap-6">
      <!-- Crypto's sent ending trades the stepper for the summary's own rows; a sale has no
           destination address to show, so its stepper stays. -->
      <dl v-if="sent && record.route === 'crypto'" class="flex flex-col gap-4">
        <div v-if="sentEgress" class="flex items-baseline justify-between gap-4">
          <dt class="text-paragraph-l text-fg-primary">Sent inc. fees</dt>
          <dd class="text-heading-m text-fg-primary">{{ sentEgress }}</dd>
        </div>
        <div class="flex items-baseline justify-between gap-4">
          <dt class="text-paragraph-l text-fg-primary">
            To this address<br />
            on <strong class="font-semibold">{{ record.destination.chain }} Network</strong>
          </dt>
          <dd class="text-heading-m text-fg-primary" :title="record.destination.address">
            {{ shortDestinationAddress(record.destination.address) }}
          </dd>
        </div>
      </dl>
      <FundingJourneyTimeline
        v-else
        :progress="progress"
        :labels="WITHDRAWAL_JOURNEY_LABELS"
        :completed-steps="done"
        :message="message"
        :failed-label="failedLabel"
        subject="Withdrawal"
      />
      <p v-if="residueNote" class="text-body-s text-fg-secondary">{{ residueNote }}</p>
      <DetailRows v-if="saleRows.length > 0" :rows="saleRows" muted />

      <PillButton v-if="refunded" class="mt-auto" @click="emit('return-funds')">
        Return funds
      </PillButton>
      <PillButton v-else-if="canRetry" class="mt-auto" :disabled="busy" @click="emit('retry')">
        Try again
      </PillButton>
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
        v-if="sent || (sideExit && !canRetry && !refunded)"
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
