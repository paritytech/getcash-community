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
import { paidDetailRows, quoteDetailRows } from "../../funding/quote-rows";
import { formatWhenShort, type JourneySteps } from "../../utils/journey";
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
// startOver asks it to re-enter this route for a fresh attempt at the same top-up.
const emit = defineEmits<{ fees: []; refund: []; close: []; startOver: [] }>();
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
 * The route's own timeline: crypto shows three steps, the card rail five.
 *
 * The store owns the scale whenever a request is on screen — the completed count and the milestone
 * keys are both on it, and a second definition here would draw the last step as current and lose
 * the settled timestamp. The list's word on the route only stands in before the top-up is live.
 */
const steps = computed<JourneySteps>(() => {
  if (session.lastState !== null || !props.topUp) return session.journeySteps;
  return props.topUp.route === "crypto" ? 3 : 5;
});
const crypto = computed(() => steps.value === 3);

/** The design names the expired step itself, not "<stage> failed". */
const failedLabel = computed(() => {
  const kind = failure.value?.kind;
  if (kind === "expired" || kind === "stale") return "Expired";
  if (session.fundingError === DEPOSIT_EXPIRED_REASON) return "Expired";
  return null;
});
/** Nothing was paid on an expired top-up, so it carries no quote rows. */
const expired = computed(() => failedLabel.value !== null);

/**
 * Whether this top-up's money came back rather than being kept.
 *
 * Crypto refunds land at the request's own key; a card refund goes to the card. Either way the
 * buyer was charged and then made whole, which is a different ending from a decline — where no
 * money moved at all — and the screen says different things about the two.
 */
const refundedEnding = computed(
  () =>
    (failure.value !== null && refundedFailure(failure.value.kind)) ||
    session.meldRefunded ||
    storedFailure.value?.refunded === true,
);

/**
 * The live quote's Fees and Total leave when nothing is being bought any more.
 *
 * An expired top-up never charged anyone, so it has nothing to show. A concluded fiat top-up is
 * the opposite case: money did move, and the design replaces the forward-looking quote with what
 * was actually paid — see `paidDetailRows`. So this drops the quote rows for both, and the paid
 * rows below take over wherever there is something to say.
 */
const heroFailed = computed(
  () =>
    progress.value?.view.kind === "failed" ||
    failure.value !== null ||
    storedFailure.value !== null,
);

/**
 * A fiat top-up that has ended, whichever way. The design gives it a receipt rather than a quote:
 * what was charged, who took it, and the funding request's id to trace it by.
 */
const concluded = computed(
  () => !crypto.value && !expired.value && (heroFailed.value || finished.value),
);

/**
 * A refunded crypto top-up gets rows too, naming the network and the rail that handled it.
 *
 * Not the deposit figure: that belongs to the deposit screen, and repeating it beside a refund
 * reads as a second charge. What became of the money — how much came back and the transaction
 * that returned it — is the refund guide's to tell, where it can be linked and copied.
 */
const cryptoRefund = computed(() => crypto.value && refundedEnding.value);

const hideRows = computed(() => expired.value || concluded.value || refundedEnding.value);

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

/**
 * Whether this top-up's deposit went back to the request's own key — the one ending that needs the
 * recovery guide.
 *
 * The crypto rail only. A refunded card goes back to the card with nothing for the buyer to do,
 * and the guide has no chain, key or address to draw for it; offering it there is a button into an
 * empty screen.
 *
 * Either account will do. A live request answers from its world; one opened out of history answers
 * from the record, and the guide re-derives the address and key from the request's own identity —
 * they are a pure function of it, so the world being gone does not put the money out of reach.
 */
const refunded = computed(() => {
  if (!crypto.value) return false;
  if (failure.value !== null && refundedFailure(failure.value.kind)) return true;
  return storedFailure.value?.refunded === true && props.topUp?.request !== undefined;
});
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
/** The rows come from the shared helper, so the journey and the settled receipt present the same
 *  quote identically. The crypto rail doesn't restate the deposit amount here — the deposit screen
 *  owns that figure — but the settled receipt, which has no deposit screen, still shows it. */
const detailRows = computed(() =>
  quoteView.value?.crypto ? [] : quoteDetailRows(quoteView.value),
);

/** The live request's provider and reference, else the list's own record. */
const paidRows = computed(() => {
  if (!concluded.value && !cryptoRefund.value) return [];
  const details = props.topUp?.details;
  const provider = session.meldServiceProvider ?? details?.provider?.label;
  // The crypto rail has no id to show: its refund transaction is the chain's, and nothing
  // persists it. The network stands in its place as the fact the record can answer.
  const reference = cryptoRefund.value ? undefined : (session.meldReference ?? details?.reference);
  const network = cryptoRefund.value ? details?.network?.label : undefined;
  return paidDetailRows(quoteView.value, {
    ...(provider ? { provider } : {}),
    ...(reference ? { reference } : {}),
    ...(network ? { network } : {}),
  });
});

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
    session.meldStage === "failed" &&
    session.meldFailureCode !== "unobserved",
);

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
        :steps="steps"
        :message="message"
        :delayed="delayed"
        :failed-label="failedLabel"
      />

      <DetailRows v-if="detailRows.length && !hideRows" :rows="detailRows" @fees="emit('fees')" />

      <!-- What an ended top-up actually cost: the charge and its handles on a fiat rail, the sum
           sent and its network on a refunded crypto one. -->
      <DetailRows v-if="paidRows.length" :rows="paidRows" @fees="emit('fees')" />

      <!-- The way back to a refunded deposit drills into the recovery guide, which carries the
           refund's own status line and the key that moves it. -->
      <PillButton v-if="refunded" class="mt-auto" @click="emit('refund')">
        Refund info
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
