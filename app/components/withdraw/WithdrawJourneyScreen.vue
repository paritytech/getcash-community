<script setup lang="ts">
// The withdrawal's journey: from the payment out of the balance to the funds at the destination.
// Everything shown is read from the record; the actions go back to the route.
import { computed } from "vue";
import { Check, RefreshCcw, X } from "lucide-vue-next";
import { formatBaseUnits, SELL_TOKEN } from "@getsome/meld";
import { useFundingProgressClock } from "../../composables/useFundingProgressClock";
import {
  paymentTaken,
  saleAwaitingDeposit,
  type WithdrawalRecord,
} from "../../funding/requests/model";
import { formatWhenShort } from "../../utils/journey";
import { shortAddress } from "../../withdraw/destinations";
import { withdrawalFailureText } from "../../withdraw/failure-copy";
import {
  WITHDRAWAL_JOURNEY_LABELS,
  withdrawalJourneyDone,
  withdrawalProgress,
  withdrawalProgressProfile,
} from "../../withdraw/progress";
import FundingJourneyTimeline from "../funding/progress/FundingJourneyTimeline.vue";
import CashAmount from "../ui/CashAmount.vue";
import PillButton from "../ui/PillButton.vue";

const props = defineProps<{
  record: WithdrawalRecord;
  /** A line the record does not carry: a refused cancel, a retry that could not start. */
  notice: string | null;
  busy: boolean;
}>();
const emit = defineEmits<{ cancel: []; retry: []; close: [] }>();

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
  return failure.value?.step === "payment" ? "Payment failed" : null;
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
    if (saleAwaitingDeposit(props.record)) return "Waiting for you to finish with the provider";
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

/** What a sale left over once the provider was paid, and where it is. Silent for a remainder too
 *  small to send back, which stays with the withdrawal. A sale that ended unpaid sends everything
 *  back, which its failure already says, so only the arrival is added. */
const residueNote = computed(() => {
  const residue = props.record.residue;
  if (residue === undefined || !residue.returning) return null;
  if (residue.whole === true || residue.amount === undefined) {
    return residue.returned ? "Your funds came back to your balance as CASH." : null;
  }
  const amount = `${formatBaseUnits(SELL_TOKEN, (BigInt(residue.amount) / 1_000_000n) * 1_000_000n)} ${SELL_TOKEN.symbol}`;
  return residue.returned
    ? `The ${amount} left over came back to your balance as CASH.`
    : `The ${amount} left over is on its way back to your balance.`;
});

/** Cancel is offered only while nothing was paid and the host has nothing in hand. */
const canCancel = computed(
  () => status.value.kind === "awaiting-payment" && !paymentTaken(props.record),
);
const canRetry = computed(() => status.value.kind === "failed" && status.value.recoverable);
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

      <PillButton v-if="canRetry" class="mt-auto" :disabled="busy" @click="emit('retry')">
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
