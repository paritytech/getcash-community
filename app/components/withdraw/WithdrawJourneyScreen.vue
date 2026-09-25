<script setup lang="ts">
// The withdrawal's journey: from the payment out of the balance to the funds at the destination.
// Everything shown is read from the record; the actions go back to the route.
import { computed } from "vue";
import { ArrowUpRight, RefreshCcw, X } from "lucide-vue-next";
import { formatSourceAmount, SOURCE_CONFIG_BY_ID } from "@getsome/chainflip";
import { useFundingProgressClock } from "../../composables/useFundingProgressClock";
import { paymentTaken, type WithdrawalRecord } from "../../funding/requests/model";
import { formatWhenShort } from "../../utils/journey";
import { shortAddress } from "../../withdraw/destinations";
import { sourceIdFor } from "~~/lib/config";
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
  return failure.value?.step === "payment" ? "Payment failed" : null;
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
    return props.record.payment.requestedAt === undefined
      ? "Waiting for your payment"
      : "Your payment is being processed";
  }
  return null;
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
      <p
        class="mt-2 text-display-m"
        :class="sideExit ? 'text-fg-secondary' : 'text-fg-primary'"
      >
        <CashAmount :amount="record.amountHuman" :sign="sent ? '-' : ''" />
      </p>
      <p v-if="sentWhen" class="text-paragraph-l text-fg-secondary">{{ sentWhen }}</p>
    </div>

    <div class="mt-6 flex flex-1 flex-col gap-6">
      <!-- The sent ending trades the stepper for the summary's own rows. -->
      <dl v-if="sent" class="flex flex-col gap-4">
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
            {{ shortAddress(record.destination.address) }}
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
      />

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
