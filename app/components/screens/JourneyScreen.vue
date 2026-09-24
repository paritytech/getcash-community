<script setup lang="ts">
// The finish of a top-up: the timeline from a confirmed deposit to CASH in the balance, shared by
// every package.
import { computed } from "vue";
import { Plus, RefreshCcw, X } from "lucide-vue-next";
import type { SourceId } from "@getsome/core";
import { SOURCE_CONFIG_BY_ID } from "@getsome/chainflip";
import { useFundingProgressClock } from "../../composables/useFundingProgressClock";
import { useJourneyQuote } from "../../composables/useJourneyQuote";
import type { FundingJourneyStatus } from "../../funding/handoff";
import { projectFundingProgress, type FundingProgressProjection } from "../../funding/progress";
import { effectiveSourceId } from "../../funding/requests/model";
import { bankEndingText, endingLabel, isExpiredEnding } from "../../funding/journey-endings";
import {
  journeyMoneyRows,
  paidDetailRows,
  quoteDetailRows,
  type QuoteRow,
} from "../../funding/quote-rows";
import { journeyScaleOf, type JourneyScale } from "../../funding/requests/views";
import { providerNameOf } from "../../funding/top-up-projection";
import type { FundingTopUp } from "../../funding/top-ups";
import { useRequestsStore } from "../../stores/requests";
import { useSessionStore } from "../../stores/session";
import { cashAmount, fmtCash, toCashBase } from "../../utils/cash";
import { currencyConfig } from "../../funding/config";
import { fmtFiat, isMoneyAmount } from "../../utils/money";
import { formatWhenShort, shortRef } from "../../utils/journey";
import { refundedFailure } from "../../utils/recovery";
import FundingJourneyTimeline from "../funding/progress/FundingJourneyTimeline.vue";
import CashAmount from "../ui/CashAmount.vue";
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

/** How many markers the timeline draws as done, counted on `scale`. The request on screen counts
 *  them; a journey opened from history has none, and takes the count the list's own record made —
 *  a top-up that was paid and converted before it failed must not redraw as though it never
 *  started. */
const completedSteps = computed(() =>
  requests.foregroundRecord !== null ? requests.journeyDone : (props.topUp?.journeyDone ?? 1),
);

/** Nothing was paid on an expired top-up, so it carries no quote rows. Opened from history there
 *  is no live failure to read, so the record's own word stands in. */
const expired = computed(
  () =>
    isExpiredEnding(failure.value?.kind, requests.fundingError) ||
    storedFailure.value?.expired === true,
);
/** The design names the ending itself, not "<stage> failed": a window that closed, a bank that
 *  said no, a payment that came back. */
const failedLabel = computed(() => endingLabel(expired.value, requests.meldFailureCode));

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
    requests.meldRefunded ||
    storedFailure.value?.refunded === true,
);

/** Whether this journey's top-up stopped rather than finished, live or as history stored it. */
const heroFailed = computed(
  () =>
    progress.value?.view.kind === "failed" ||
    failure.value !== null ||
    storedFailure.value !== null,
);

/** Which money rows this ending shows; the rule is the design's, not this screen's. */
const moneyRows = computed(() =>
  journeyMoneyRows({
    crypto: crypto.value,
    expired: expired.value,
    failed: heroFailed.value,
    refunded: refundedEnding.value,
  }),
);

/**
 * A refunded crypto top-up gets rows too, naming the network and the rail that handled it.
 *
 * Not the deposit figure: that belongs to the deposit screen, and repeating it beside a refund
 * reads as a second charge. What became of the money — how much came back and the transaction
 * that returned it — is the refund guide's to tell, where it can be linked and copied.
 */
const cryptoRefund = computed(() => crypto.value && refundedEnding.value);

const creditedAmount = computed(() =>
  requests.claimedBase != null ? fmtCash(requests.claimedBase) : session.amountHuman,
);
/** What the buyer asked for. The store's amount is empty until the request is live; the list's
 *  word on it fills in. */
const quotedAmount = computed(() => session.amountHuman || (props.topUp?.amount ?? ""));

/**
 * What the rail will actually deliver, when the rate moved it off the quote.
 *
 * The fiat was priced when the payment started and the CASH is bought when it lands, so a transfer
 * spending days in between can arrive against a different rate. The claim is the first thing that
 * knows the real figure, and it knows it before the journey ends — so the screen corrects itself
 * while the buyer is still watching, rather than surprising them at the end.
 *
 * The bank rail only. A card is priced and bought minutes apart, and `claimedBase` is a whole
 * burner sweep rather than the typed figure, so a card's claim differs by rounding rather than by
 * a rate — news the buyer cannot act on, under a sentence about money being on its way. A crypto
 * swap that misses its bounds is refunded rather than filled short, and that ending has its own
 * words.
 */
const revisedAmount = computed<string | null>(() => {
  if (!bank.value) return null;
  const claimed = requests.claimedBase;
  const quoted = toCashBase(quotedAmount.value);
  if (claimed === null || quoted === null || claimed === quoted) return null;
  return fmtCash(claimed);
});

const amountParts = computed(() => {
  if (finished.value) return { sign: "+", amount: creditedAmount.value };
  // A rate that moved is news the hero carries too: the figure the buyer is owed, not the one
  // they were quoted.
  return { sign: "", amount: revisedAmount.value ?? quotedAmount.value };
});

/** When the top-up reached its end, under the hero: the live milestone (stamped at the route's
 *  last step) for a credit that just landed, else the list's own timestamp. A failed top-up gets
 *  one too — when it stopped is part of what a buyer opens this screen to find out. */
const settledWhen = computed(() => {
  // The store stamps the credit at the card scale's last step, whatever scale the route draws.
  const at = finished.value ? (requests.milestones[5] ?? storedEndedAt.value) : storedEndedAt.value;
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
  const record = requests.foregroundRecord;
  if (!record) return "";
  return SOURCE_CONFIG_BY_ID.get(effectiveSourceId(record.ref) as SourceId)?.asset ?? "";
});
/** The quote the rows read, resolved the same way the fee breakdown behind them resolves it. */
const { quote: quoteView } = useJourneyQuote(() => props.topUp);

/** The handle the provider knows this payment by: what the buyer quotes their bank, and what
 *  support asks for. Off the request's own record before the live session, so a journey re-opened
 *  from the list long after that session is gone still has it. */
const reference = computed(
  () => props.topUp?.reference ?? requests.foregroundRecord?.meldFundingRequestId ?? null,
);

/** The bank rail names the act the buyer performed — a transfer was sent — where the shared row
 *  says a card was paid. The rows are the helper's; only the words change. */
const wordForBank = (rows: QuoteRow[]): QuoteRow[] =>
  bank.value
    ? rows.map((row) =>
        row.label === "You paid inc. fees"
          ? { ...row, label: "Sent inc. fees" }
          : row.label === "You paid"
            ? { ...row, label: "Sent" }
            : row,
      )
    : rows;

/**
 * The rows come from the shared helper, so the journey and the settled receipt present the same
 * quote identically — except a bank transfer still in flight, which restates the transfer itself:
 * what to send, what to quote with it, and when it lands. The buyer may still be in their banking
 * app, and this is the only place those three survive once the provider's page is behind them. A
 * transfer that has arrived or failed is past instructing anyone, and reads as the receipt every
 * other rail leaves.
 */
const detailRows = computed<DetailRow[]>(() => {
  if (moneyRows.value !== "quote") return [];
  const q = quoteView.value;
  if (bank.value && !finished.value && !heroFailed.value) {
    const rows: DetailRow[] = [];
    if (q)
      rows.push({
        // Once the rail has the money there is nothing left to instruct, so the line reads as the
        // concluded journeys word it: what was sent, not what to send.
        label: requests.railSeen ? "Sent inc. fees" : "Send this exact amount inc. fees",
        value: fmtFiat(q.amount, q.symbol),
        fees: isMoneyAmount(q.fee ?? ""),
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
      note: `Final ${currencyConfig.name} depends on the rate on arrival`,
    });
    return rows;
  }
  return wordForBank(quoteDetailRows(q));
});

/** The request on screen's provider and reference, else the list's own record. */
const paidRows = computed(() => {
  if (moneyRows.value !== "receipt") return [];
  const live = requests.foregroundRecord;
  const details = props.topUp?.details;
  // The live record and the list's row have to name the provider identically, so both go
  // through `providerNameOf`; the row's label is already its output.
  const provider = (live ? providerNameOf(live) : undefined) ?? details?.provider?.label;
  // The crypto rail has no id to show: its refund transaction is the chain's, and nothing
  // persists it. The network stands in its place as the fact the record can answer.
  const paidReference = cryptoRefund.value
    ? undefined
    : (live?.meldFundingRequestId ?? props.topUp?.reference);
  const network = cryptoRefund.value ? details?.network?.label : undefined;
  return wordForBank(
    paidDetailRows(quoteView.value, {
      ...(provider ? { provider } : {}),
      ...(paidReference ? { reference: paidReference } : {}),
      ...(network ? { network } : {}),
    }),
  );
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
    // The rail has the money — seen, processing or delivered — or the burner holds the deposit:
    // it is out of the buyer's hands, and there is nothing left to call off.
    !requests.railSeen &&
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
  // Nothing live to ask: the record's own reason is the only account of the failure left.
  if (storedFailure.value?.reason) return storedFailure.value.reason;
  if (requests.fundingNotice) return requests.fundingNotice;
  if (delayed.value) {
    // Each rail waits on something else: the card provider's retry vs chain confirmations.
    return crypto.value
      ? "Waiting for network confirmations. This can take a while"
      : "Taking a little longer than usual";
  }
  // The rate moved under a payment that is still on its way: say so before the hero's new figure
  // is read as a mistake, and name both amounts so the difference is the buyer's to check. Above
  // the rail's own line, which by then reads "Bank transfer confirmed" — true, and not the news.
  // Below the notices, which are what a buyer has to act on.
  if (revisedAmount.value) {
    return `Rates changed while your money was on its way. You'll get ${cashAmount(revisedAmount.value)} instead of ${cashAmount(quotedAmount.value)}`;
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
        <CashAmount :sign="amountParts.sign" :amount="amountParts.amount" />
      </p>
      <p v-if="settledWhen" class="text-paragraph-l text-fg-secondary">{{ settledWhen }}</p>
    </div>

    <div class="mt-6 flex flex-1 flex-col gap-6">
      <!-- The stepper leaves once the CASH lands. -->
      <FundingJourneyTimeline
        v-if="progress && !finished"
        :progress="progress"
        :scale="scale"
        :completed-steps="completedSteps"
        :message="message"
        :delayed="delayed"
        :failed-label="failedLabel"
      />

      <DetailRows v-if="detailRows.length" :rows="detailRows" @fees="emit('fees')" />

      <!-- What an ended top-up actually cost: the charge and its handles on a fiat rail, the sum
           sent and its network on a refunded crypto one. The transaction id copies, so the screen
           carries the confirmation. -->
      <DetailRows v-if="paidRows.length" :rows="paidRows" @fees="emit('fees')" />
      <CopiedPill v-if="paidRows.length" />

      <!-- The way back to a refunded deposit drills into the recovery guide, which carries the
           refund's own status line and the key that moves it. -->
      <PillButton v-if="refunded" class="mt-auto" @click="emit('refund')"> Refund info </PillButton>

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
      <PillButton v-if="canCancel" variant="danger" class="mt-auto" @click="emit('cancel')">
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
