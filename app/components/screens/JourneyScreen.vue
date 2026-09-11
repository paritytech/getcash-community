<script setup lang="ts">
// The finish of a top-up: the timeline from a confirmed deposit to CASH in the balance, shared by
// every package.
import { computed } from "vue";
import { Plus, RefreshCcw, X } from "lucide-vue-next";
import { SOURCE_CONFIG_BY_ID } from "@getsome/chainflip";
import { useFundingProgressClock } from "../../composables/useFundingProgressClock";
import type { FundingJourneyStatus } from "../../funding/handoff";
import { projectFundingProgress, type FundingProgressProjection } from "../../funding/progress";
import type { FundingTopUp } from "../../funding/top-ups";
import { DEPOSIT_EXPIRED_REASON, useSessionStore } from "../../stores/session";
import { fmtCash } from "../../utils/cash";
import { fmtFiat, isMoneyAmount } from "../../utils/money";
import { formatWhenShort } from "../../utils/journey";
import { refundedFailure } from "../../utils/recovery";
import FundingJourneyTimeline from "../funding/progress/FundingJourneyTimeline.vue";
import DetailRows from "../ui/DetailRows.vue";
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
// fees and refund ask the host to swap in their drill-ins; close leaves the finished journey;
// again leaves an expired one for a fresh purchase at the amount screen.
const emit = defineEmits<{ fees: []; refund: []; close: []; again: [] }>();
const session = useSessionStore();

const cadence = computed(
  () => session.foregroundProgress?.snapshot.profile.cadenceMs ?? props.progress?.cadenceMs ?? null,
);
const now = useFundingProgressClock(cadence);
const progress = computed(() => {
  const foreground = session.foregroundProgress;
  if (foreground) {
    return projectFundingProgress({
      snapshot: foreground.snapshot,
      createdAt: foreground.startedAt,
      now: now.value,
    });
  }
  return props.progress ?? null;
});

const state = computed(() => session.lastState);
const finished = computed(() => session.phase === "done");
const failure = computed(() => (state.value?.phase === "failed" ? state.value.failure : null));
const failedText = computed(() => session.fundingError ?? failure.value?.message ?? null);

/**
 * What the list stored about a top-up that already failed. A journey opened from history often has
 * no live request behind it — the world was torn down, or the record outlived it — and this is then
 * the only account of what happened.
 */
const storedFailure = computed(() =>
  props.topUp?.state.kind === "failed" ? props.topUp.state : null,
);
/** When the top-up reached its end, for a journey with nothing live to read it from. */
const storedEndedAt = computed(() => {
  const stored = props.topUp?.state;
  return stored?.kind === "settled" || stored?.kind === "failed" ? stored.at : null;
});

/**
 * The route's own timeline: crypto has no "Approved" leg and shows four steps.
 *
 * The store owns the scale whenever a request is on screen — the completed count and the milestone
 * keys are both on it, and a second definition here would draw the last step as current and lose
 * the settled timestamp. The list's word on the route only stands in before the top-up is live.
 */
const steps = computed<4 | 5>(() => {
  if (session.lastState !== null || !props.topUp) return session.journeySteps;
  return props.topUp.route === "crypto" ? 4 : 5;
});
const crypto = computed(() => steps.value === 4);

/** The design names the expired step itself, not "<stage> failed". */
const failedLabel = computed(() => {
  const kind = failure.value?.kind;
  if (kind === "expired" || kind === "stale") return "Expired";
  if (session.fundingError === DEPOSIT_EXPIRED_REASON) return "Expired";
  return null;
});
/** Nothing was paid on an expired top-up: no quote rows, and the way out is a fresh one. */
const expired = computed(() => failedLabel.value !== null);
/** The quote rows leave with the money: nothing was kept on an expired or refunded top-up. */
const hideRows = computed(
  () =>
    expired.value ||
    (failure.value !== null && refundedFailure(failure.value.kind)) ||
    storedFailure.value?.refunded === true,
);

const heroFailed = computed(
  () =>
    progress.value?.view.kind === "failed" ||
    failure.value !== null ||
    storedFailure.value !== null,
);

const creditedAmount = computed(() =>
  session.claimedBase != null ? fmtCash(session.claimedBase) : session.amountHuman,
);
const amountText = computed(() => {
  if (finished.value) return `+${creditedAmount.value} $CASH`;
  // The store's amount is empty until the request is live; the list's word on it fills in.
  return `${session.amountHuman || (props.topUp?.amount ?? "")} $CASH`;
});

/** When the top-up reached its end, under the hero: the live milestone (stamped at the route's
 *  last step) for a credit that just landed, else the list's own timestamp. A failed top-up gets
 *  one too — when it stopped is part of what a buyer opens this screen to find out. */
const settledWhen = computed(() => {
  const at = finished.value
    ? (session.milestones[steps.value] ?? storedEndedAt.value)
    : storedEndedAt.value;
  return at != null ? formatWhenShort(at) : null;
});

/** Whether the failed swap's deposit is being refunded to this request's own key. */
const refunded = computed(
  () =>
    failure.value !== null && refundedFailure(failure.value.kind) && session.refundAddress !== null,
);
const asset = computed(() => {
  const sourceId = state.value?.sourceId;
  return sourceId ? (SOURCE_CONFIG_BY_ID.get(sourceId)?.asset ?? "") : "";
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
    crypto: props.topUp?.route === "crypto",
    live: false,
  };
});
const detailRows = computed(() => {
  const q = quoteView.value;
  if (!q) return [];
  // Symbol-first for the fiat rails ("€50.55"); crypto keeps its full-precision ticker form.
  const money = (amount: string) =>
    q.crypto ? `${amount} ${q.symbol}` : fmtFiat(amount, q.symbol);
  const rows: { label: string; value: string; fees?: boolean }[] = [];
  // The fee row drills into the breakdown screen when the live quote backs it with a fee the
  // breakdown can actually split; an unparseable one still shows, as plain text.
  if (q.fee)
    rows.push({ label: "Fees", value: money(q.fee), fees: q.live && isMoneyAmount(q.fee) });
  rows.push({ label: "Total", value: money(q.amount) });
  return rows;
});

/** Temporarily stuck (the provider is retrying): amber on the stepper, never terminal. */
const delayed = computed(() => session.meldDelayed && !finished.value && !heroFailed.value);

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
  if (failedText.value) return failedText.value;
  // Nothing live to ask: the record's own reason is the only account of the failure left.
  if (storedFailure.value?.reason) return storedFailure.value.reason;
  if (session.fundingNotice) return session.fundingNotice;
  if (delayed.value) {
    // Each rail waits on something else: the card provider's retry vs chain confirmations.
    return crypto.value
      ? "Waiting for network confirmations. This can take a while"
      : "Taking a little longer than usual";
  }
  if (props.status) return props.status.text;
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
        :completed-steps="session.journeyDone"
        :steps="steps"
        :message="message"
        :delayed="delayed"
        :failed-label="failedLabel"
      />

      <DetailRows v-if="detailRows.length && !hideRows" :rows="detailRows" @fees="emit('fees')" />

      <!-- The way back to a refunded deposit drills into the return-funds guide, which carries
           the refund's own status line. -->
      <PillButton v-if="refunded" class="mt-auto" @click="emit('refund')">
        Return funds
      </PillButton>

      <PillButton v-if="failure?.recoverable" class="mt-auto" @click="session.retry()">
        Try again
      </PillButton>

      <PillButton v-if="expired" class="mt-auto" @click="emit('again')">
        Add funds again
      </PillButton>

      <PillButton v-if="finished" variant="tertiary" class="mt-auto" @click="emit('close')">
        Close
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
