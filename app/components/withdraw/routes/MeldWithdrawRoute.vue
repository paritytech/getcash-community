<script setup lang="ts">
// The Meld sell package: region and payout method, a quote with its fee breakdown, KYC in the
// provider's widget, then the journey through to fiat. Shaped like `CryptoWithdrawRoute.vue` on
// the withdrawal side and `MeldFundingRoute.vue` on the buy side — the amount was already taken by
// the shell before this package loaded, the region/quote/fee screens mirror the buy ones, and the
// journey is the SAME `WithdrawJourneyScreen` every other withdrawal rail uses. Opened from the
// list, this loads the same route (see `getcashWithdrawPackages`).
//
// The one structural fork from the buy side: a sell cannot show its provider widget until it has
// been quoted and confirmed (a buy opens its widget straight off the amount), so "quote" and "kyc"
// are two screens here where the buy side's pay screen and its widget share one. Cancel is offered
// on the "kyc" screen itself, the same low-friction way the buy side offers it under its own
// widget — no confirm dialog, because nothing has moved yet — and it disappears the moment that
// stops being true (`withdrawalCancellable`), never later than the journey screen would enforce it
// on its own.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useMeldSellQuote } from "../../../composables/useMeldSellQuote";
import { useMeldWithdrawalPoll } from "../../../composables/useMeldWithdrawalPoll";
import { useWithdrawalRequest } from "../../../composables/useWithdrawalRequest";
import type { FundingPackageEmits } from "../../../funding/handoff";
import { meldDepositKnown } from "../../../funding/requests/model";
import type { FundingSelection } from "../../../funding/selection";
import type { FundingTopUp } from "../../../funding/top-ups";
import { useMeldSellClients } from "../../../stores/meldSellClients";
import { useRequestsStore } from "../../../stores/requests";
import { toCashBase } from "../../../utils/cash";
import { requestRefKey } from "../../../utils/request-index";
import { withdrawalCancellable } from "../../../withdraw/cancel";
import {
  formatCommittedCrypto,
  formatEstimatedPayout,
  meldSellDestination,
} from "../../../withdraw/meld-sell";
import { withdrawalRequestRef } from "../../../withdraw/rows";
import { corridorOptions } from "~~/lib/supported";
import Toolbar from "../../ui/Toolbar.vue";
import WithdrawJourneyScreen from "../WithdrawJourneyScreen.vue";
import MeldSellFeeDetailsScreen from "../MeldSellFeeDetailsScreen.vue";
import MeldSellKycScreen from "../MeldSellKycScreen.vue";
import MeldSellQuoteScreen from "../MeldSellQuoteScreen.vue";

const props = defineProps<{
  /** A fresh withdrawal: the amount and route (card or bank) the shell took. */
  selection?: FundingSelection | null;
  /** A withdrawal opened from the list. */
  topUp?: FundingTopUp | null;
}>();
const emit = defineEmits<FundingPackageEmits>();

const initialMethod: "card" | "bank" | null =
  props.selection?.route === "card" || props.selection?.route === "bank"
    ? props.selection.route
    : props.topUp?.route === "card" || props.topUp?.route === "bank"
      ? props.topUp.route
      : null;
if (initialMethod === null) {
  throw new Error("the Meld withdrawal package needs a card or bank route");
}
const method = initialMethod;
const destination = meldSellDestination(method);

const requests = useRequestsStore();
const clients = useMeldSellClients();
const withdrawal = useWithdrawalRequest();
// Nothing to quote for a withdrawal resumed from the list: its sale was already committed, and
// re-sizing here would only disagree with what the record already carries.
const quote = props.topUp
  ? null
  : useMeldSellQuote(method, toCashBase(props.selection!.amount) ?? 0n);
const poll = useMeldWithdrawalPoll();

type Step = "quote" | "fees" | "kyc" | "journey";
const step = ref<Step>(props.topUp ? "journey" : "quote");
const widgetUrl = ref<string | null>(null);
const cancelling = ref(false);
const cancelNotice = ref<string | null>(null);
const busy = ref(false);
const notice = ref<string | null>(null);

const record = computed(() => requests.foregroundWithdrawal);
/** A withdrawal opened from the list whose record the store no longer has. */
const unavailable = computed(() => {
  if (!props.topUp || record.value !== null) return false;
  const ref = withdrawalRequestRef(props.topUp.id);
  return ref === null || !requests.has(ref);
});

const methodLabel = method === "bank" ? "bank transfer" : "card";
const toolbar = computed<{ title: string; back: boolean }>(() => {
  switch (step.value) {
    case "fees":
      return { title: "Fees", back: true };
    case "kyc":
      return { title: "", back: true };
    case "journey":
      return { title: props.topUp ? "Status" : `Withdraw via ${methodLabel}`, back: true };
    default:
      return { title: `Withdraw via ${methodLabel}`, back: true };
  }
});

function onBack() {
  if (step.value === "fees") {
    step.value = "quote";
    return;
  }
  // Leaving the widget or the journey leaves the sale running; the list keeps it.
  emit("back");
}

// Fallback region list and picker rows, the same shape the buy side's own pay screen builds
// (see `MeldPayScreen.vue`), read through `quote`'s corridor state rather than a store.
const FALLBACK_COUNTRIES = [
  { country: "US", name: "United States" },
  { country: "CA", name: "Canada" },
  { country: "GB", name: "United Kingdom" },
  { country: "DE", name: "Germany" },
  { country: "AU", name: "Australia" },
  { country: "BR", name: "Brazil" },
] as const;
const countryOptions = computed(() => {
  if (!quote) return [];
  const live = quote.countries.value;
  const base =
    live && live.length > 0
      ? live
      : FALLBACK_COUNTRIES.map((c) => ({ country: c.country, name: c.name }));
  return corridorOptions(base, quote.corridorByCountry.value, method);
});

// Both routed through `../../../withdraw/meld-sell`, the one module the estimate-versus-exact
// guarantee lives in — see its header. Formatting either figure by hand here, even to the same
// visible result, is exactly the drift that module exists to make impossible: this screen must
// never be the one place that can drop the "≈" or quietly re-derive the exact figure differently.
const committedText = computed(() => {
  const c = quote?.commitment.value;
  return c === null || c === undefined ? null : formatCommittedCrypto(c.planck.toString());
});
const payoutText = computed(() => {
  const q = quote?.quote.value;
  return q ? formatEstimatedPayout(q.provider.destinationAmount, q.fiat) : null;
});

const canContinue = computed(() => {
  if (!quote) return false;
  return (
    !quote.committing.value &&
    !quote.loading.value &&
    !quote.methodUnavailable.value &&
    quote.commitError.value === null &&
    quote.quoteError.value === null &&
    quote.quote.value !== null &&
    !quote.starting.value
  );
});

async function confirmQuote() {
  if (!quote) return;
  const outcome = await quote.confirm(destination);
  if (!outcome.ok) return; // quote.startError already carries the reason
  widgetUrl.value = outcome.widgetUrl ?? null;
  const current = requests.get(outcome.ref);
  // `confirm` only ever resolves `ok` once its own client is in hand, so this is never null.
  if (
    current !== undefined &&
    current.kind === "withdrawal" &&
    current.rail.provider === "meld" &&
    quote.client.value !== null
  ) {
    poll.start(outcome.ref, quote.client.value, current.rail.sale.meldFundingRequestId);
  }
  step.value = "kyc";
}

const canCancelSale = computed(() => record.value !== null && withdrawalCancellable(record.value));
async function cancelSale() {
  const current = record.value;
  if (current === null || cancelling.value) return;
  cancelling.value = true;
  try {
    const outcome = await withdrawal.cancel(current.ref);
    if (outcome === "ok") {
      emit("back");
      return;
    }
    cancelNotice.value =
      outcome === "refused"
        ? "Your verification already progressed far enough that the withdrawal continues."
        : "The cancel could not be confirmed. Check your connection and try again.";
  } finally {
    cancelling.value = false;
  }
}

async function retryJourney() {
  const current = record.value;
  if (current === null || busy.value) return;
  busy.value = true;
  notice.value = null;
  try {
    if (!(await withdrawal.retry(current.ref))) {
      notice.value = "The withdrawal could not be restarted. Try again in a moment.";
    }
  } finally {
    busy.value = false;
  }
}

// Once the sale discloses its deposit address the widget's job is done — the reconcile loop
// takes the payment and the worker from here — so the screen moves on by itself, the same way
// the buy side's `useMeldHandoff` hands off once its own deposit clears.
watch(
  () => (record.value?.rail.provider === "meld" ? meldDepositKnown(record.value.rail) : false),
  (known) => {
    if (known && step.value === "kyc") step.value = "journey";
  },
);

// A record that moves clears the line about the last action.
watch(
  () => record.value?.status.kind,
  () => {
    notice.value = null;
  },
);

onMounted(async () => {
  if (!props.topUp) {
    void quote!.init();
    return;
  }
  const ref = withdrawalRequestRef(props.topUp.id);
  if (ref === null || !requests.has(ref)) return;
  requests.setForeground(ref);
  const current = requests.get(ref);
  if (current === undefined || current.kind !== "withdrawal" || current.rail.provider !== "meld") {
    return;
  }
  if (meldDepositKnown(current.rail)) return; // step stays "journey"
  // Still mid-KYC: reopen the widget on THE SAME client this sale was opened on, kept by
  // `useMeldSellClients` across the whole app session, not a fresh one built here. A fresh
  // instance would lose the fake stand-in's own scripted progress on every "leave the KYC
  // screen, reopen from the list" (see `useMeldSellClients`'s header) — a real adapter has no
  // such limit, since its state lives server-side, never on the object making the call, but this
  // build never talks to one.
  step.value = "kyc";
  const client = clients.clientFor(requestRefKey(ref));
  try {
    const status = await client.getStatus(current.rail.sale.meldFundingRequestId);
    widgetUrl.value = status.serviceProviderWidgetUrl ?? status.widgetUrl ?? null;
  } catch (e: unknown) {
    console.warn("[withdraw] could not reopen the sale's verification page:", e);
  }
  poll.start(ref, client, current.rail.sale.meldFundingRequestId);
});
onUnmounted(() => {
  // The poll that follows the request on screen stops; the worker and the store keep the sale.
  requests.leave();
});
</script>

<template>
  <main
    class="fixed inset-x-0 mx-auto flex w-full max-w-md flex-col overflow-hidden bg-surface-main"
    style="
      top: var(--vvt, 0px);
      height: var(--vvh, 100dvh);
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
    "
  >
    <Toolbar :title="toolbar.title" :back="toolbar.back" @back="onBack" />

    <div class="flex min-h-0 flex-1 flex-col" :class="step === 'kyc' ? '' : 'px-6 pt-6'">
      <MeldSellQuoteScreen
        v-if="step === 'quote' && quote"
        :method="method"
        :country="quote.country.value"
        :country-options="countryOptions"
        :committed-text="committedText"
        :payout-text="payoutText"
        :committing="quote.committing.value"
        :loading="quote.loading.value"
        :unavailable="quote.methodUnavailable.value"
        :commit-error="quote.commitError.value"
        :quote-error="quote.quoteError.value"
        :other-method-label="quote.otherMethod.value === 'bank' ? 'Bank transfer' : 'Card'"
        :other-method-available="quote.otherMethodAvailable.value"
        :can-continue="canContinue"
        :starting="quote.starting.value"
        :start-error="quote.startError.value"
        @pick-country="quote.setCountry($event)"
        @retry="quote.requote()"
        @use-other-method="emit('switchRoute', quote.otherMethod.value)"
        @use-crypto="emit('switchRoute', 'crypto')"
        @fees="step = 'fees'"
        @continue="confirmQuote"
      />
      <MeldSellFeeDetailsScreen
        v-else-if="step === 'fees' && quote && quote.quote.value && committedText"
        :committed-text="committedText"
        :entry="quote.quote.value.provider"
        :fiat="quote.quote.value.fiat"
        @back="step = 'quote'"
      />
      <template v-else-if="step === 'kyc'">
        <MeldSellKycScreen
          :widget-url="widgetUrl"
          :can-cancel="canCancelSale"
          :cancelling="cancelling"
          @cancel="cancelSale"
        />
        <p
          v-if="cancelNotice"
          class="mx-6 mb-4 text-center text-body-m text-fg-secondary"
          role="status"
        >
          {{ cancelNotice }}
        </p>
      </template>
      <WithdrawJourneyScreen
        v-else-if="step === 'journey' && record"
        :record="record"
        :notice="notice"
        :busy="busy"
        @cancel="cancelSale"
        @retry="retryJourney"
        @close="emit('back')"
      />
      <div
        v-else-if="step === 'journey' && unavailable"
        class="flex flex-1 flex-col items-center pt-16 text-center"
      >
        <h1 class="text-heading-l text-fg-primary">Withdrawal unavailable</h1>
        <p class="mt-2 text-body-m text-fg-secondary">
          This withdrawal is no longer available. Return to see your latest activity.
        </p>
      </div>
      <div v-else class="flex flex-col items-center gap-4 pt-16">
        <span
          class="inline-block size-8 animate-spin rounded-full border-[3px] border-stroke-primary border-t-fg-primary"
        />
        <p class="text-body-m text-fg-secondary">Opening your withdrawal…</p>
      </div>
    </div>
  </main>
</template>
