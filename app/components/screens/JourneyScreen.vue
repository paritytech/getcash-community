<script setup lang="ts">
// The finish of a top-up: the timeline from a confirmed deposit to CASH in the balance, shared by
// every package.
import { computed } from "vue";
import { Check, Plus, RefreshCcw, X } from "lucide-vue-next";
import type { SourceId } from "@getsome/core";
import { SOURCE_CONFIG_BY_ID } from "@getsome/chainflip";
import { useFundingProgressClock } from "../../composables/useFundingProgressClock";
import type { FundingJourneyStatus } from "../../funding/handoff";
import { projectFundingProgress, type FundingProgressProjection } from "../../funding/progress";
import { effectiveSourceId } from "../../funding/requests/model";
import { bankEndingText, endingLabel, isExpiredEnding } from "../../funding/journey-endings";
import { journeyScaleOf, type JourneyScale } from "../../funding/requests/views";
import type { FundingTopUp } from "../../funding/top-ups";
import { useRequestsStore } from "../../stores/requests";
import { useSessionStore } from "../../stores/session";
import { cashAmount, fmtCash } from "../../utils/cash";
import { fmtFiat, isMoneyAmount } from "../../utils/money";
import { formatWhenShort, shortRef } from "../../utils/journey";
import { refundedFailure } from "../../utils/recovery";
import FundingJourneyTimeline from "../funding/progress/FundingJourneyTimeline.vue";
import DetailRows, { type DetailRow } from "../ui/DetailRows.vue";
import PillButton from "../ui/PillButton.vue";

const props = defineProps<{
  /**
   * A stored projection for a request not (yet) on screen; the live foreground wins when present.
   */
  progress?: FundingProgressProjection | null;
  /** The package's own word on its payment, shown above the timeline. */
  status?: FundingJourneyStatus | null;
  /** The top-up as the list knows it; its stored quote backs the detail rows until the request
   *  is live in the store. */
  topUp?: FundingTopUp | null;
}>();
// fees and refund ask the host to swap in their drill-ins; cancel asks it for the cancel
// confirmation; close leaves the finished journey; startOver asks it to re-enter this route for a
// fresh attempt at the same top-up.
const emit = defineEmits<{ fees: []; refund: []; cancel: []; close: []; startOver: [] }>();
const session = useSessionStore();
const requests = useRequestsStore();

const cadence = computed(
  () =>
    requests.foregroundProgress?.snapshot.profile.cadenceMs ?? props.progress?.cadenceMs ?? null,
);
const now = useFundingProgressClock(cadence);
const progress = computed(() => {
  const foreground = requests.foregroundProgress;
  if (foreground) {
    return projectFundingProgress({
      snapshot: foreground.snapshot,
      createdAt: foreground.startedAt,
      now: now.value,
    });
  }
  return props.progress ?? null;
});

const finished = computed(() => requests.phase === "done");
const failure = computed(() =>
  requests.phase === "failed" ? (requests.foregroundRecord?.failure ?? null) : null,
);
const failedText = computed(() => requests.fundingError ?? failure.value?.message ?? null);

/**
 * The route's own timeline: the card rail shows five stops, crypto and bank three of their own.
 *
 * The store owns the scale whenever a request is on screen; the list's word on the route only
 * stands in before the top-up is live. `requests.journeyDone` counts on that same scale.
 */
const scale = computed<JourneyScale>(() => {
  if (requests.foregroundRecord !== null || !props.topUp) return session.journeyScale;
  return journeyScaleOf(props.topUp.route);
});
const crypto = computed(() => scale.value === "crypto");
const bank = computed(() => scale.value === "bank");

/** Nothing was paid on an expired top-up, so it carries no quote rows. */
const expired = computed(() => isExpiredEnding(failure.value?.kind, requests.fundingError));
/** The design names the ending itself, not "<stage> failed": a window that closed, a bank that
 *  said no, a payment that came back. */
const failedLabel = computed(() => endingLabel(expired.value, requests.meldFailureCode));
/** The quote rows leave with the money: nothing was kept on an expired or refunded top-up. */
const hideRows = computed(
  () => expired.value || (failure.value !== null && refundedFailure(failure.value.kind)),
);

const heroFailed = computed(() => progress.value?.view.kind === "failed" || failure.value !== null);

const creditedAmount = computed(() =>
  requests.claimedBase != null ? fmtCash(requests.claimedBase) : session.amountHuman,
);
const amountText = computed(() => {
  if (finished.value) return `+${cashAmount(creditedAmount.value)}`;
  // The store's amount is empty until the request is live; the list's word on it fills in.
  return cashAmount(session.amountHuman || (props.topUp?.amount ?? ""));
});

/** When the CASH landed: the live milestone (stamped at the route's last step), else the list's
 *  settled timestamp. */
const settledWhen = computed(() => {
  if (!finished.value) return null;
  const at =
    requests.milestones[5] ?? (props.topUp?.state.kind === "settled" ? props.topUp.state.at : null);
  return at != null ? formatWhenShort(at) : null;
});

/** Whether the failed swap's deposit is being refunded to this request's own key. */
const refunded = computed(
  () =>
    failure.value !== null && refundedFailure(failure.value.kind) && session.refundAddress !== null,
);
const asset = computed(() => {
  const record = requests.foregroundRecord;
  if (!record) return "";
  return SOURCE_CONFIG_BY_ID.get(effectiveSourceId(record.ref) as SourceId)?.asset ?? "";
});
/** The rows' source: the live quote, else the top-up's stored one. Only the live quote carries
 *  the split the fee drill-in needs. */
const quoteView = computed(() => {
  const q = session.quoted;
  if (q) {
    return {
      amount: q.send,
      symbol: q.symbol,
      fee: q.fee ?? null,
      provider: q.provider ?? null,
      crypto: session.method === "crypto",
      live: true,
    };
  }
  const stored = props.topUp?.quote;
  if (!stored) return null;
  return {
    amount: stored.amount,
    symbol: stored.symbol,
    fee: stored.fee ?? null,
    provider: stored.provider ?? null,
    crypto: props.topUp?.route === "crypto",
    live: false,
  };
});
/** Whether the fee breakdown can be drilled into: only the live quote carries the split. */
const feesDrillIn = (q: NonNullable<typeof quoteView.value>) =>
  !!q.fee && q.live && isMoneyAmount(q.fee);

/** The handle the provider knows this payment by: what the buyer quotes their bank, and what
 *  support asks for. Off the request's own record before the live session, so a journey re-opened
 *  from the list long after that session is gone still has it. */
const reference = computed(
  () => props.topUp?.reference ?? requests.foregroundRecord?.meldFundingRequestId ?? null,
);

/**
 * What the buyer paid, and on a failure who to chase about it.
 *
 * A separate Fees row restated part of the number sitting right beside it; the total already
 * contains the fee, so the label says so and the chevron carries the split. The drill-in is
 * offered only when the live quote backs it with a fee the breakdown can itemize — a stored quote
 * or an unparseable fee leaves the row as plain text.
 *
 * The failure rows stand on their own. A journey with no quote to show still has a payment the
 * buyer may need to ask about, so what they would have to quote does not hang on a figure being
 * available to print above it.
 */
const detailRows = computed<DetailRow[]>(() => {
  const q = quoteView.value;
  const rows: DetailRow[] = [];
  // Symbol-first for the fiat rails ("€50.55"); crypto keeps its full-precision ticker form.
  const money = (amount: string) =>
    q && !q.crypto ? fmtFiat(amount, q.symbol) : `${amount} ${q?.symbol ?? ""}`.trim();

  // A bank transfer still in flight restates the transfer itself: what to send, what to quote
  // with it, and when it lands. The buyer may still be in their banking app, and this is the only
  // place those three survive once the provider's page is behind them. A transfer that has
  // arrived or failed is past instructing anyone, and reads as the receipt every other rail
  // leaves.
  if (bank.value && !finished.value && !heroFailed.value) {
    if (q)
      rows.push({
        label: "Send this exact amount inc. fees",
        value: money(q.amount),
        fees: feesDrillIn(q),
      });
    if (reference.value)
      rows.push({
        label: "Reference",
        value: shortRef(reference.value),
        copy: reference.value,
      });
    rows.push({
      label: "Arrives",
      value: "1–2 business days",
      note: "Final $CASH depends on the rate on arrival",
    });
    return rows;
  }

  if (q) {
    // Each rail names the act the buyer performed: a transfer was sent, a card was paid.
    const paid = q.fee ? "You paid inc. fees" : "You paid";
    rows.push({
      label: bank.value ? (q.fee ? "Sent inc. fees" : "Sent") : paid,
      value: money(q.amount),
      fees: feesDrillIn(q),
    });
  }
  // Who to chase and what to quote them. Only on a failure: on a journey that is working or done
  // these are rows of reference nobody needs, but a declined payment is the moment a buyer has
  // something to ask about. An expired top-up keeps none of it: no payment was ever made against
  // the request.
  if (heroFailed.value && !expired.value) {
    // A transfer is quoted back to a bank by its reference; the provider knows the same payment
    // by its funding request, so the two labels carry one handle until the adapter reports a
    // transaction id of its own.
    if (bank.value && reference.value)
      rows.push({
        label: "Reference",
        value: shortRef(reference.value),
        copy: reference.value,
      });
    if (q?.provider) rows.push({ label: "Provider", value: q.provider });
    if (reference.value)
      rows.push({
        label: "Transaction ID",
        value: shortRef(reference.value),
        copy: reference.value,
      });
  }
  return rows;
});

/** The bank transfer's own wording for an ending the adapter words for a card. */
const bankFailureText = computed(() => {
  if (!bank.value) return null;
  const q = quoteView.value;
  return bankEndingText(requests.meldFailureCode, q ? fmtFiat(q.amount, q.symbol) : null);
});

/**
 * Cancel, bank only: the provider's pay page can still be withdrawn while no money has arrived.
 *
 * "I've sent funds" does not close it — on this rail that is the buyer's word and not the money,
 * and a transfer they never made would otherwise leave a payable page standing. The confirmation
 * screen carries the warning for the buyer who did already pay.
 */
const canCancel = computed(
  () =>
    bank.value &&
    requests.foregroundRecord !== null &&
    !finished.value &&
    !heroFailed.value &&
    // The rail delivered, or the burner holds the deposit: the money is ours to convert and there
    // is nothing left to call off.
    requests.meldStage !== "complete" &&
    !requests.fundsSeen &&
    !requests.claiming &&
    session.cancelReady,
);

/**
 * Whether to offer a fresh attempt at a card or bank top-up that ended.
 *
 * The failed request itself cannot be re-entered — its pay page is dead and the provider will not
 * take a second payment against it — so the offer is a new funding request, which is why the
 * button says "Start over" rather than "Try again".
 *
 * Withheld on `unobserved` alone: there the rail could not tell whether the buyer was charged, so
 * inviting a second payment risks charging them twice.
 */
const canStartOver = computed(
  () =>
    session.method !== "crypto" &&
    requests.meldStage === "failed" &&
    requests.meldFailureCode !== "unobserved",
);

/** Temporarily stuck (the provider is retrying): amber on the stepper, never terminal. */
const delayed = computed(() => requests.meldDelayed && !finished.value && !heroFailed.value);

/** The one ribbon line under the stepper: a failure reason, an out-of-band notice, a transient
 *  delay, or the rail's own word on its payment. The last matters most on the bank rail, where
 *  "Confirming your bank transfer…" can be the state for days. */
const message = computed(() => {
  // The stored reason is the terse "Channel expired"; the design spells out what it means.
  if (expired.value) return "This top-up expired because no funds arrived in time";
  // Chainflip refunds when the swap cannot execute within the quote's price bounds, so the rate
  // is the cause by construction; the deposit returns minus the refund transfer's network fees.
  if (failure.value?.kind === "refunded") {
    return `The rate moved too far to complete the swap. Your ${asset.value || "crypto"} was sent back, minus network fees.`;
  }
  if (bankFailureText.value) return bankFailureText.value;
  if (failedText.value) return failedText.value;
  if (requests.fundingNotice) return requests.fundingNotice;
  if (delayed.value) {
    // Each rail waits on something else: the card provider's retry vs chain confirmations.
    return crypto.value
      ? "Waiting for network confirmations. This can take a while"
      : "Taking a little longer than usual";
  }
  if (props.status) return props.status.text;
  // Nothing has been reported on a bank transfer yet: days can pass here, so the ribbon says what
  // the silence means rather than leaving the stepper to speak for itself.
  if (bank.value && !finished.value) {
    return "If you've sent the money from your bank, it's on its way to us. We'll let you know when it's arrived.";
  }
  return null;
});
</script>

<template>
  <!-- The scroller carries -mx-4/px-4 so the timeline card's bleed isn't clipped: overflow-y-auto
       also clips x, and the clip runs at the padding box. -->
  <div class="-mx-4 flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-6">
    <div class="flex flex-col items-center text-center">
      <span
        class="flex size-14 items-center justify-center rounded-full"
        :class="heroFailed ? 'journey-hero-failed' : 'bg-surface-container'"
      >
        <X v-if="heroFailed" class="size-6 text-fg-error" aria-hidden="true" />
        <Plus v-else-if="finished" class="size-6 text-fg-primary" aria-hidden="true" />
        <RefreshCcw v-else class="size-6 text-fg-primary" aria-hidden="true" />
      </span>
      <p
        class="mt-2 text-display-m"
        :class="finished ? 'text-fg-success' : heroFailed ? 'text-fg-secondary' : 'text-fg-primary'"
      >
        {{ amountText }}
      </p>
      <p v-if="settledWhen" class="text-paragraph-l text-fg-secondary">{{ settledWhen }}</p>
    </div>

    <div class="mt-6 flex flex-1 flex-col gap-6">
      <!-- The stepper leaves once the CASH lands. -->
      <FundingJourneyTimeline
        v-if="progress && !finished"
        :progress="progress"
        :scale="scale"
        :completed-steps="requests.journeyDone"
        :message="message"
        :delayed="delayed"
        :failed-label="failedLabel"
      />

      <DetailRows
        v-if="detailRows.length && !hideRows"
        :rows="detailRows"
        @fees="emit('fees')"
      />

      <!-- The way back to a refunded deposit drills into the return-funds guide, which carries
           the refund's own status line. -->
      <PillButton v-if="refunded" class="mt-auto" @click="emit('refund')">
        Return funds
      </PillButton>

      <!-- A recoverable failure comes first on either rail: the payment landed and only the credit
           is outstanding, so re-entering it is the fix. Starting a second payment there would
           charge the buyer twice. -->
      <PillButton v-if="failure?.recoverable" class="mt-auto" @click="session.retry()">
        Try again
      </PillButton>

      <PillButton v-else-if="canStartOver" class="mt-auto" @click="emit('startOver')">
        Start over
      </PillButton>

      <PillButton v-if="finished" variant="tertiary" class="mt-auto" @click="emit('close')">
        Close
      </PillButton>

      <!-- The way out of a transfer that has not been paid. The confirmation is the route's, so
           this only asks for it. -->
      <PillButton
        v-if="canCancel"
        variant="danger"
        class="mt-auto"
        @click="emit('cancel')"
      >
        Cancel
      </PillButton>
    </div>
  </div>
</template>

<style scoped>
/* The failed hero circle binds the red-alpha primitive in the design; no semantic
 * token covers it (reported gap). */
.journey-hero-failed {
  background: var(--palette-red-alpha-24);
}
</style>
