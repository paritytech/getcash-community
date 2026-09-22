<script setup lang="ts">
// The withdrawal's journey: from the payment out of the balance to the funds at the destination.
// Everything shown is read from the record; the actions go back to the route.
import { computed } from "vue";
import { Check, RefreshCcw, X } from "lucide-vue-next";
import { useFundingProgressClock } from "../../composables/useFundingProgressClock";
import { fundingSelectorConfig } from "../../funding/config";
import type { WithdrawalRecord } from "../../funding/requests/model";
import { formatWhenShort } from "../../utils/journey";
import { withdrawalCancellable } from "../../withdraw/cancel";
import { shortAddress } from "../../withdraw/destinations";
import { withdrawalFailureText } from "../../withdraw/failure-copy";
import {
  formatCommittedCrypto,
  formatEstimatedPayout,
  meldSentMessage,
} from "../../withdraw/meld-sell";
import {
  WITHDRAWAL_JOURNEY_LABELS,
  withdrawalJourneyDone,
  withdrawalProgress,
  withdrawalProgressProfile,
} from "../../withdraw/progress";
import FundingJourneyTimeline from "../funding/progress/FundingJourneyTimeline.vue";
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

const amountText = computed(() => `${props.record.amountHuman} ${fundingSelectorConfig.asset}`);
const sentWhen = computed(() =>
  status.value.kind === "sent" ? formatWhenShort(status.value.at) : null,
);

/** The Meld sale this record carries, or null for every other rail. Read once here so the
 *  template's estimate-versus-exact block and the messages below share one narrowing. */
const meldSale = computed(() =>
  props.record.rail.provider === "meld" ? props.record.rail.sale : null,
);
/** `record.route` is only ever "card" or "bank" on a Meld rail — see `WithdrawalRecord.route` —
 *  but the type is shared with the crypto rails', so this narrows it back for the copy helpers. */
const meldMethod = computed(() =>
  props.record.route === "card" || props.record.route === "bank" ? props.record.route : null,
);

/** The one line under the stepper. */
const message = computed(() => {
  if (props.notice) return props.notice;
  if (status.value.kind === "cancelled") return "This withdrawal was cancelled.";
  if (failure.value) return withdrawalFailureText(failure.value);
  if (status.value.kind === "sent") {
    return meldMethod.value !== null
      ? meldSentMessage(meldMethod.value)
      : `Sent to ${shortAddress(props.record.destination.address)}`;
  }
  // The funding product is approved without a sheet, so a requested payment is processing. True
  // for a Meld sale too: by the time this status can still show, the provider has already
  // disclosed where to pay it (`WithdrawJourneyScreen` is only ever reached once KYC has —
  // otherwise the route's own widget step is still on screen), so what remains really is the
  // purse's own payment, not the sale.
  if (status.value.kind === "awaiting-payment") {
    return props.record.payment.requestedAt === undefined
      ? "Waiting for your payment"
      : "Your payment is being processed";
  }
  return progress.value.view.label;
});

/** Cancel is offered only while nothing was paid, the host has nothing in hand, and — for a Meld
 *  sale — the provider has not yet disclosed a deposit address; see `withdrawalCancellable`. */
const canCancel = computed(() => withdrawalCancellable(props.record));
const canRetry = computed(() => status.value.kind === "failed" && status.value.recoverable);

/** The exact crypto committed and the estimated fiat it is expected to become, for a Meld sale
 *  that has not yet settled — once it has, `sentWhen`/`message` already say what actually
 *  happened, and repeating a payout that is no longer an estimate would misstate it as one. */
const meldDetail = computed(() => {
  const sale = meldSale.value;
  if (sale === null || sent.value) return null;
  return {
    committed: formatCommittedCrypto(sale.committedAmount),
    payout: formatEstimatedPayout(sale.quotedFiatAmount, sale.quotedFiatCurrency),
  };
});
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
        {{ amountText }}
      </p>
      <p v-if="sentWhen" class="text-paragraph-l text-fg-secondary">{{ sentWhen }}</p>
      <!-- The exact crypto against the estimated fiat, kept apart the whole way through: the
           provider has not locked the second figure, and will not until it converts. -->
      <p v-if="meldDetail" class="mt-1 text-paragraph-l text-fg-secondary">
        Selling {{ meldDetail.committed }} for {{ meldDetail.payout }}
      </p>
    </div>

    <div class="mt-6 flex flex-1 flex-col gap-6">
      <FundingJourneyTimeline
        :progress="progress"
        :steps="3"
        :labels="WITHDRAWAL_JOURNEY_LABELS"
        :completed-steps="done"
        :message="message"
        :failed-label="failedLabel"
      />

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
