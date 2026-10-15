<script setup lang="ts">
// The finish of a top-up: the timeline from a confirmed deposit to CASH in the balance, shared by
// every package.
import { computed, ref, watch } from "vue";
import { RefreshCcw, X } from "lucide-vue-next";
import { useFundingProgressClock } from "../../composables/useFundingProgressClock";
import { useJourneyQuote } from "../../composables/useJourneyQuote";
import { headerAmount, isExpiredEnding } from "../../funding/journey-endings";
import {
  failureDetailRows,
  journeyMoneyRows,
  quoteDetailRows,
  type QuoteRow,
} from "../../funding/quote-rows";
import { creditedAmountOf } from "../../funding/requests/views";
import { CLOSE, type FailureAction } from "../../funding/timeline/failure";
import { TIMELINE_CADENCE_MS } from "../../funding/timeline/timelines";
import type { FundingTopUp } from "../../funding/top-ups";
import { useRequestsStore } from "../../stores/requests";
import { useSessionStore } from "../../stores/session";
import { cashInText, fmtCash, toCashBase } from "../../utils/cash";
import { currencyConfig } from "../../funding/config";
import { fmtFiat, isMoneyAmount } from "../../utils/money";
import { formatWhenShort, shortRef } from "../../utils/journey";
import FundingTimeline from "../funding/timeline/FundingTimeline.vue";
import TimelineBand from "../funding/timeline/TimelineBand.vue";
import CashAmount from "../ui/CashAmount.vue";
import DetailRows, { type DetailRow } from "../ui/DetailRows.vue";
import PillButton from "../ui/PillButton.vue";
import TransactionIcon from "../ui/TransactionIcon.vue";
import { nextSuccessStage, openingSuccessStage } from "./success-stage";

const props = defineProps<{
  /** The top-up as the list knows it; its stored quote backs the detail rows until the request
   *  is live in the store. */
  topUp?: FundingTopUp | null;
}>();
// fees and refund ask the host to swap in their drill-ins; cancel asks it for the cancel
// confirmation; close leaves the finished journey; startOver asks it to re-enter this route for a
// fresh attempt at the same top-up.
const emit = defineEmits<{
  fees: [];
  refund: [];
  recover: [];
  cancel: [];
  close: [];
  startOver: [];
}>();
const session = useSessionStore();
const requests = useRequestsStore();

const now = useFundingProgressClock(() =>
  requests.foregroundRecord !== null ? TIMELINE_CADENCE_MS : null,
);
/** The top-up's timeline once it opened or ended: the live record's, else the list's for a journey
 *  opened from history. */
const timeline = computed(() =>
  requests.foregroundRecord !== null
    ? requests.foregroundTimeline(now.value)
    : props.topUp?.timeline,
);
const finished = computed(() => requests.phase === "done");

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const success = ref(openingSuccessStage(finished.value));
watch(finished, (done) => {
  success.value = done
    ? nextSuccessStage(success.value, {
        kind: "succeeded",
        animate: timeline.value?.view !== undefined && !reducedMotion(),
      })
    : "none";
});
const successShown = computed(() => success.value === "playing" || success.value === "shown");
const successPlaying = computed(() => success.value === "playing");
/** The success motion brings the transaction icon in as the refresh icon spins out. */
const SUCCESS_ICON_DELAY_MS = 910;
const failure = computed(() =>
  requests.phase === "failed" ? (requests.foregroundRecord?.failure ?? null) : null,
);
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

/** The route of the top-up on screen. The store owns it whenever a request is on screen; the
 *  list's word on the route only stands in before the top-up is live, and the selected method
 *  before there is either. */
const route = computed(
  () => requests.foregroundRecord?.route ?? props.topUp?.route ?? session.method,
);
const crypto = computed(() => route.value === "crypto");
const bank = computed(() => route.value === "bank");

/** Nothing was paid on an expired top-up, so it carries no quote rows. Opened from history there
 *  is no live failure to read, so the record's own word stands in. */
const expired = computed(
  () =>
    isExpiredEnding(failure.value?.kind, requests.fundingError) ||
    storedFailure.value?.expired === true,
);

/** Whether this journey's top-up stopped rather than finished, live or as history stored it. */
const heroFailed = computed(() => failure.value !== null || storedFailure.value !== null);

/** Which money rows this ending shows; the rule is the design's, not this screen's. */
const moneyRows = computed(() =>
  journeyMoneyRows({
    crypto: crypto.value,
    expired: expired.value,
    failed: heroFailed.value,
  }),
);

/** What the Host credited, once the top-up ended with a credit: the live record's, else what the
 *  list stored for a journey opened from history. */
const creditedAmount = computed(() => {
  const record = requests.foregroundRecord;
  if (record !== null) return creditedAmountOf(record);
  const stored = props.topUp?.state;
  return stored?.kind === "settled" || stored?.kind === "failed"
    ? stored.creditedAmount
    : undefined;
});
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

const amounts = computed(() => ({
  asked: quotedAmount.value,
  credited: creditedAmount.value,
  revised: revisedAmount.value,
}));
/** The header until the success screen shows; the success motion turns it into `successAmount`. */
const pendingAmount = computed(() =>
  headerAmount(heroFailed.value ? "failure" : null, amounts.value),
);
const successAmount = computed(() => headerAmount("success", amounts.value));

/** When the top-up reached its end, under the hero: the live record's credit for one that just
 *  landed, else the list's own timestamp. A failed top-up gets one too: when it stopped is part
 *  of what a buyer opens this screen to find out. */
const settledWhen = computed(() => {
  const record = requests.foregroundRecord;
  const at = successShown.value
    ? (record?.settledAt ?? record?.creditedAt ?? storedEndedAt.value)
    : storedEndedAt.value;
  return at != null ? formatWhenShort(at) : null;
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
 * quote identically — except a bank transfer, which restates the transfer itself: what to send,
 * what to quote with it, and when it lands. The buyer may still be in their banking app, and this
 * is the only place those three survive once the provider's page is behind them. On success the
 * arrival row goes and the others stay.
 */
const detailRows = computed<DetailRow[]>(() => {
  if (moneyRows.value !== "quote") return [];
  const q = quoteView.value;
  if (bank.value) {
    const rows: DetailRow[] = [];
    if (q)
      rows.push({
        // Once the rail has the money there is nothing left to instruct, so the line reads as the
        // concluded journeys word it: what was sent, not what to send.
        label:
          requests.railSeen || finished.value
            ? "Sent inc. fees"
            : "Send this exact amount inc. fees",
        value: fmtFiat(q.amount, q.symbol),
        fees: isMoneyAmount(q.fee ?? ""),
      });
    if (reference.value)
      rows.push({
        label: "Reference",
        value: shortRef(reference.value),
        copy: reference.value,
      });
    // Last, so the success motion can fade it out.
    if (success.value !== "shown")
      rows.push({
        label: "Arrives",
        value: "1–2 business days",
        note: `Final ${currencyConfig.name} depends on the rate on arrival`,
      });
    return rows;
  }
  return quoteDetailRows(q);
});

/** What an ended top-up cost, then its failure details: who took the payment, why it ended, and
 *  the reference to quote them. */
const endedRows = computed<DetailRow[]>(() => [
  ...(moneyRows.value === "receipt" ? wordForBank(quoteDetailRows(quoteView.value)) : []),
  ...failureDetailRows(timeline.value?.failure?.details ?? {}),
]);

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
 * The way on from a failure. Trying again and the top-up's own account's guide act on the request
 * on screen, so without one the journey can only close.
 */
const failureAction = computed<FailureAction | null>(() => {
  const action = timeline.value?.failure?.action;
  if (action === undefined) return null;
  const needsRequest =
    action.kind === "try-again" ||
    (action.kind === "get-back" && action.from === "deposit-account");
  return needsRequest && requests.foregroundRecord === null ? CLOSE : action;
});

/** Explains a header amount that moved off the quote. */
const rateChangeNotice = computed(() =>
  revisedAmount.value
    ? `Rates changed while your money was on its way. You'll get ${cashInText(revisedAmount.value)} instead of ${cashInText(quotedAmount.value)}`
    : null,
);

/** The band's text: the failure, then the rate-change notice, which explains the header's new
 *  amount, then the timeline's own message. A failure the timeline does not word is the store's. */
const timelineMessage = computed(() => {
  if (timeline.value?.failure) return timeline.value.failure.text;
  if (heroFailed.value) return requests.fundingError;
  return rateChangeNotice.value ?? timeline.value?.message?.text ?? null;
});
const timelineDetail = computed(() => (heroFailed.value ? null : (timeline.value?.detail ?? null)));
/** The band keeps its last words while the timeline completes and leaves on success. */
const band = ref({ message: timelineMessage.value, detail: timelineDetail.value });
watch([timelineMessage, timelineDetail], ([message, detail]) => {
  if (!finished.value) band.value = { message, detail };
});
</script>

<template>
  <!-- The scroller carries -mx-4/px-4 so the timeline card's bleed isn't clipped: overflow-y-auto
       also clips x, and the clip runs at the padding box. -->
  <div class="-mx-4 flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-6">
    <div class="flex flex-col items-center text-center">
      <span
        class="journey-stack size-14 rounded-full"
        :class="heroFailed ? 'journey-hero-failed' : 'bg-surface-container'"
      >
        <X v-if="heroFailed" class="size-6 text-fg-error" aria-hidden="true" />
        <template v-else>
          <RefreshCcw
            v-if="!successShown || successPlaying"
            class="size-6 text-fg-primary"
            :class="{ 'journey-icon-out': successPlaying }"
            aria-hidden="true"
          />
          <TransactionIcon
            v-if="successShown"
            class="size-14"
            :animate="successPlaying"
            :delay="SUCCESS_ICON_DELAY_MS"
          />
        </template>
      </span>
      <p class="journey-stack mt-2 text-display-m">
        <CashAmount
          v-if="!successShown || successPlaying"
          v-bind="pendingAmount"
          :class="[
            heroFailed ? 'text-fg-secondary' : 'text-fg-primary',
            { 'journey-amount-out': successPlaying },
          ]"
        />
        <CashAmount
          v-if="successShown"
          v-bind="successAmount"
          class="text-fg-success"
          :class="{ 'journey-amount-in': successPlaying }"
        />
      </p>
      <div v-if="settledWhen" :class="{ 'journey-date-in': successPlaying }">
        <p class="text-paragraph-l text-fg-secondary">{{ settledWhen }}</p>
      </div>
    </div>

    <div class="mt-6 flex flex-1 flex-col gap-6">
      <!-- The timeline leaves once the CASH lands. -->
      <div
        v-if="timeline && success !== 'shown'"
        :class="{ 'journey-timeline-out': successPlaying }"
      >
        <FundingTimeline
          v-if="timeline.view"
          :view="timeline.view"
          :message="band.message"
          :detail="band.detail"
          @added="success = nextSuccessStage(success, { kind: 'drawn' })"
        />
        <TimelineBand v-else :message="band.message" :detail="band.detail" />
      </div>

      <!-- On a bank transfer the last row is Arrives, which fades as the success motion plays. -->
      <DetailRows
        v-if="detailRows.length"
        :rows="detailRows"
        :class="{ 'journey-last-row-out': bank && successPlaying }"
        @fees="emit('fees')"
      />

      <!-- The reference copies, so the screen carries the confirmation. -->
      <DetailRows v-if="endedRows.length" :rows="endedRows" @fees="emit('fees')" />
      <CopiedPill v-if="endedRows.length" />

      <!-- The refund guide for money the provider returned to the refund key, the recovery guide
           for money on the top-up's own account. -->
      <PillButton
        v-if="failureAction?.kind === 'get-back'"
        class="mt-auto"
        @click="failureAction.from === 'refund-key' ? emit('refund') : emit('recover')"
      >
        Get your {{ failureAction.source }} back
      </PillButton>
      <PillButton
        v-else-if="failureAction?.kind === 'try-again'"
        class="mt-auto"
        @click="session.retry()"
      >
        Try again
      </PillButton>
      <PillButton
        v-else-if="failureAction?.kind === 'start-over'"
        class="mt-auto"
        @click="emit('startOver')"
      >
        Start over
      </PillButton>

      <PillButton
        v-if="successShown || failureAction?.kind === 'close'"
        variant="tertiary"
        class="mt-auto"
        :class="{ 'journey-close-in': successPlaying }"
        @click="emit('close')"
      >
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

/* The hero's icons and amounts overlap while one turns into the other. */
.journey-stack {
  display: grid;
  place-items: center;
}

.journey-stack > * {
  grid-area: 1 / 1;
}

/* The success motion, timed from the timeline's last tick. */
.journey-timeline-out {
  display: grid;
  animation: journey-collapse 820ms cubic-bezier(0.65, 0, 0.35, 1) 900ms both;
}

.journey-timeline-out > * {
  animation: journey-dissolve 560ms ease-out 700ms both;
}

.journey-icon-out {
  animation: journey-spin-out 700ms cubic-bezier(0.55, 0, 1, 0.45) 350ms both;
}

.journey-amount-out {
  animation: journey-drop-out 360ms ease-in 1000ms both;
}

.journey-amount-in {
  animation: journey-drop-in 480ms ease-out 1000ms both;
}

.journey-date-in {
  display: grid;
  animation: journey-expand 820ms cubic-bezier(0.65, 0, 0.35, 1) 900ms both;
}

.journey-date-in > p {
  overflow: hidden;
  animation: journey-drop-in 480ms ease-out 1000ms both;
}

.journey-last-row-out > :deep(:last-child) {
  animation: journey-fade-out 900ms ease-in-out 1300ms both;
}

.journey-close-in {
  animation: journey-rise 400ms ease-out 1720ms both;
}

/* The column's gap-6 goes with the timeline, so the details end where the end state has them. */
@keyframes journey-collapse {
  from {
    grid-template-rows: 1fr;
  }
  to {
    grid-template-rows: 0fr;
    margin-bottom: -1.5rem;
    visibility: hidden;
  }
}

@keyframes journey-expand {
  from {
    grid-template-rows: 0fr;
  }
  to {
    grid-template-rows: 1fr;
  }
}

@keyframes journey-dissolve {
  to {
    opacity: 0;
    filter: blur(6px);
    transform: translateY(-8px) scale(0.96);
  }
}

@keyframes journey-spin-out {
  to {
    transform: rotate(900deg) scale(0);
  }
}

@keyframes journey-drop-out {
  to {
    opacity: 0;
    filter: blur(3px);
    transform: translateY(8px);
  }
}

@keyframes journey-drop-in {
  from {
    opacity: 0;
    filter: blur(3px);
    transform: translateY(-8px);
  }
}

@keyframes journey-fade-out {
  to {
    opacity: 0;
    visibility: hidden;
  }
}

@keyframes journey-rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}
</style>
