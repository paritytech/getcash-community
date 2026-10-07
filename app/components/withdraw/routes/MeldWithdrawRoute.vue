<script setup lang="ts">
// The fiat withdrawal package, card or bank through Meld: the quote with its payout country and
// fees, KYC on the provider's page, then the journey. Shaped like the crypto package: the shell
// took the amount, the journey is the shared WithdrawJourneyScreen, and a withdrawal opened from
// the list loads this route onto its record. The sale on Asset Hub is decided here, once for the
// amount and before the provider's catalog is read, and frozen into the hand-off at confirm.
// Nothing is asked of the balance until the provider names where the funds go; from there the
// record and the worker carry the sale.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { ConversionRoute } from "@getsome/funding";
import { useMeldSellQuote } from "../../../composables/useMeldSellQuote";
import { psmReserved, useWithdrawalRequest } from "../../../composables/useWithdrawalRequest";
import type { FundingPackageEmits } from "../../../funding/handoff";
import { paymentTaken, saleAwaitingDeposit } from "../../../funding/requests/model";
import type { FundingSelection } from "../../../funding/selection";
import type { FundingTopUp } from "../../../funding/top-ups";
import { useRequestsStore } from "../../../stores/requests";
import { toCashBase } from "../../../utils/cash";
import { isDemoBuild } from "../../../utils/demo";
import { localeCountry } from "../../../utils/locale";
import type { RequestRef } from "../../../utils/request-index";
import { meldSellClient } from "../../../withdraw/meld-client";
import { withdrawalRequestRef } from "../../../withdraw/rows";
import { bankRailCountries } from "~~/lib/region";
import {
  corridorOptions,
  countryName,
  namedCountry,
  type SupportedCountry,
} from "~~/lib/supported";
import CurrencySelectScreen from "../../funding/routes/CurrencySelectScreen.vue";
import Toolbar from "../../ui/Toolbar.vue";
import MeldSellFeeDetailsScreen from "../MeldSellFeeDetailsScreen.vue";
import MeldSellKycScreen from "../MeldSellKycScreen.vue";
import MeldSellQuoteScreen from "../MeldSellQuoteScreen.vue";
import WithdrawCancelScreen from "../WithdrawCancelScreen.vue";
import WithdrawJourneyScreen from "../WithdrawJourneyScreen.vue";

const props = defineProps<{
  /** A fresh withdrawal: the amount and the route the shell took. */
  selection?: FundingSelection | null;
  /** A withdrawal opened from the list. */
  topUp?: FundingTopUp | null;
}>();
const emit = defineEmits<FundingPackageEmits>();

const method = ((): "card" | "bank" => {
  const route = props.selection?.route ?? props.topUp?.route;
  if (route !== "card" && route !== "bank") {
    throw new Error(`the fiat withdrawal cannot handle the ${String(route)} route`);
  }
  return route;
})();

const requests = useRequestsStore();
const withdrawal = useWithdrawalRequest();
const amount = computed(() => props.selection?.amount ?? props.topUp?.amount ?? "");
/** The sale on Asset Hub the figure is sized on and the provider is asked for: the fiat rule,
 *  decided once the screen opens; null until then, and when it could not be decided. */
const route = ref<ConversionRoute | null>(null);
const sale = useMeldSellQuote(method, toCashBase(amount.value) ?? 0n, route);

type Step = "quote" | "fees" | "region" | "kyc" | "journey" | "cancel";
const step = ref<Step>(props.topUp ? "journey" : "quote");
const starting = ref(false);
const startError = ref<string | null>(null);
const busy = ref(false);
const cancelling = ref(false);
const notice = ref<string | null>(null);

const record = computed(() => requests.foregroundWithdrawal);
/** A withdrawal opened from the list whose record the store no longer has. */
const unavailable = computed(() => {
  if (!props.topUp || record.value !== null) return false;
  const ref = withdrawalRequestRef(props.topUp.id);
  return ref === null || !requests.has(ref);
});

const methodLabel = method === "bank" ? "bank" : "card";
const toolbar = computed<{ title: string; back: boolean }>(() => {
  switch (step.value) {
    case "fees":
      return { title: "Fees", back: true };
    case "region":
      return { title: "Choose payout country", back: true };
    case "kyc":
    case "cancel":
      return { title: "", back: true };
    case "journey":
      return { title: props.topUp ? "Status" : `Withdraw to ${methodLabel}`, back: true };
    default:
      return { title: `Withdraw to ${methodLabel}`, back: true };
  }
});

function onBack() {
  switch (step.value) {
    case "fees":
    case "region":
      step.value = "quote";
      return;
    case "cancel":
      closeCancel();
      return;
    default:
      // Leaving the provider's page or the journey leaves the sale running; the list keeps it.
      emit("back");
  }
}

/** Fallback region list, for when the adapter's live catalog is unreachable. */
const FALLBACK_COUNTRIES: SupportedCountry[] = [
  { country: "DE", name: "Germany" },
  { country: "FR", name: "France" },
  { country: "GB", name: "United Kingdom" },
  { country: "US", name: "United States" },
];

/** The regions this method pays out in: the live catalog's, else the fallback; a bank payout
 *  only where the country has a rail. */
const pickerCountries = computed(() => {
  const live = sale.countries.value;
  const named = new Map((live ?? []).map((c) => [c.country, c.name]));
  const base =
    method === "bank"
      ? bankRailCountries()
          .map((country) => ({ country, name: named.get(country) ?? countryName(country) }))
          .sort((a, b) => a.name.localeCompare(b.name))
      : live && live.length > 0
        ? live
        : FALLBACK_COUNTRIES;
  return corridorOptions(base, sale.corridors.value, method);
});

const detectedCountry = computed(() => {
  const detected = localeCountry();
  if (detected === null) return null;
  return method === "card" || bankRailCountries().includes(detected) ? detected : null;
});

const countryLabel = computed(() => namedCountry(sale.country.value, sale.countries.value));

function pickCountry(country: string) {
  step.value = "quote";
  if (country !== sale.country.value) sale.setCountry(country);
}

/** False once the route is gone, so a sale it opened is not taken or followed from a dead
 *  screen. */
let alive = true;

/** Decides the sale for the amount, then reads the provider's catalog and prices the figure for
 *  its token. A sale that cannot be decided leaves the quote unavailable. */
async function openQuote() {
  const base = toCashBase(amount.value);
  if (base !== null) {
    try {
      const live = await import("~~/lib/withdraw-live");
      route.value = await live.chooseWithdrawRoute(
        base,
        undefined,
        psmReserved(requests.openWithdrawals),
      );
    } catch (error: unknown) {
      console.warn("[withdraw] the sale could not be decided:", error);
    }
  }
  if (!alive) return;
  void sale.loadCatalog();
  void sale.refresh();
}

async function confirm() {
  const quoted = sale.quote.value;
  const amountBase = toCashBase(amount.value);
  if (quoted === null || amountBase === null || starting.value) return;
  starting.value = true;
  startError.value = null;
  try {
    const outcome = await withdrawal.startSale({
      method,
      amount: amountBase,
      country: quoted.country,
      fiat: quoted.fiat,
      paymentMethodType: quoted.paymentMethodType,
      quote: quoted.line,
      sale: quoted.sale,
      cryptoAmount: quoted.cryptoAmount,
    });
    if (!outcome.ok) {
      startError.value = outcome.reason;
      return;
    }
    // Left while the sale opened: the list keeps it and reads it in the background, and whatever
    // screen is up now keeps the foreground.
    if (!alive) return;
    requests.setForeground(outcome.ref);
    followSale(outcome.ref);
    step.value = "kyc";
  } catch (error: unknown) {
    startError.value = error instanceof Error ? error.message : String(error);
  } finally {
    starting.value = false;
  }
}

/** Reads the sale on screen through the client it was opened with, until its purse is asked. */
function followSale(withdrawalRef: RequestRef) {
  const client = meldSellClient();
  if (client !== null) requests.startSalePoll(withdrawalRef, client);
}

/** The provider's page for the sale on screen, while it still waits on KYC. */
const widgetUrl = computed(() => record.value?.sale?.widgetUrl ?? null);

/** Cancel is offered on the provider's page until the balance is asked: from then on the seller
 *  may already be approving the payment. */
const cancellable = computed(() => {
  const current = record.value;
  return (
    current !== null &&
    current.status.kind === "awaiting-payment" &&
    current.payment.requestedAt === undefined &&
    !paymentTaken(current)
  );
});

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
    notice.value =
      outcome === "refused"
        ? "The payment already went through, so the withdrawal continues."
        : "The cancel could not be confirmed. Check your connection and try again.";
    if (step.value === "cancel") step.value = "journey";
  } finally {
    cancelling.value = false;
  }
}

// The provider named where the funds go: the balance is asked now, once, from this screen, and
// the journey takes over. A record opened again later asks from here too, as it hands the worker
// the sale again when the worker no longer knows it. A price that could not be checked leaves the
// sale waiting, so it is asked again after a pause while the screen is up.
const PAY_RETRY_MS = 15_000;
let paying = false;
let payRetry: ReturnType<typeof setTimeout> | null = null;
async function payWhenKnown() {
  const current = record.value;
  // A seller on the cancel screen, or cancelling, is not asked to pay meanwhile.
  if (step.value === "cancel" || cancelling.value) return;
  if (current === null || paying || current.sale === undefined) return;
  if (saleAwaitingDeposit(current) || current.status.kind !== "awaiting-payment") return;
  if (current.payment.requestedAt !== undefined && current.witnesses.worker?.known !== false) {
    return;
  }
  paying = true;
  step.value = "journey";
  try {
    const outcome = await withdrawal.paySale(current.ref);
    if (outcome.ok) notice.value = null;
    // A sale that ended meanwhile says why on the journey; there is nothing to try again.
    if (!outcome.ok && record.value?.status.kind === "awaiting-payment") {
      notice.value = outcome.reason;
      if (payRetry === null) {
        payRetry = setTimeout(() => {
          payRetry = null;
          void payWhenKnown();
        }, PAY_RETRY_MS);
      }
    }
  } finally {
    paying = false;
  }
}
watch(
  [
    () => record.value?.handoff.channel?.id,
    () => record.value?.status.kind,
    () => record.value?.witnesses.worker?.known,
  ],
  () => void payWhenKnown(),
);

/** The cancel screen holds the pending pay retry; keeping the sale picks it up again. */
function openCancel() {
  if (payRetry !== null) clearTimeout(payRetry);
  payRetry = null;
  step.value = "cancel";
}
function closeCancel() {
  step.value = "journey";
  void payWhenKnown();
}

// The provider sends the seller back from KYC to the adapter's return page, which says so with
// `meld:verified` from the adapter's origin: the sale is read at once rather than at the next poll.
const ADAPTER_ORIGIN = (() => {
  const base = import.meta.env.VITE_MELD_BASE_URL as string | undefined;
  try {
    return base ? new URL(base).origin : null;
  } catch {
    return null;
  }
})();
function onMessage(e: MessageEvent) {
  if (!ADAPTER_ORIGIN || e.origin !== ADAPTER_ORIGIN) return;
  if ((e.data as { type?: string } | null)?.type !== "meld:verified") return;
  const current = record.value;
  const client = meldSellClient();
  if (current?.sale === undefined || client === null) return;
  void requests.observeSaleStatus(current.ref, client, current.sale.fundingRequestId);
}

// A sale that ends while its page is up (expired, ended by the provider, cancelled elsewhere)
// leaves the page for the journey, which says why.
watch(
  () => record.value?.status.kind,
  (kind) => {
    notice.value = null;
    if (step.value === "kyc" && kind !== undefined && kind !== "awaiting-payment") {
      step.value = "journey";
    }
  },
);

/** Demo Skip: the sale's provider is real on a test network but never pays out there, so its
 *  payout is taken as done by hand and the walk can reach its end. Offered only once the worker
 *  has paid the provider (its `follow` step), so the payment and the residue's way home still run
 *  for real. */
const canSkipRail = computed(() => {
  const worker = record.value?.witnesses.worker;
  return (
    isDemoBuild() &&
    step.value === "journey" &&
    record.value?.status.kind === "sending" &&
    worker?.known === true &&
    worker.phase === "follow"
  );
});

function onSkipRail() {
  const current = record.value;
  if (current === null || busy.value) return;
  void withdrawal.skipRail(current.ref).catch((error: unknown) => {
    notice.value = error instanceof Error ? error.message : String(error);
  });
}

async function retry() {
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

onMounted(() => {
  window.addEventListener("message", onMessage);
  const opened = props.topUp;
  if (!opened) {
    void openQuote();
    return;
  }
  const ref = withdrawalRequestRef(opened.id);
  if (ref === null || !requests.has(ref)) return;
  requests.setForeground(ref);
  const current = requests.get(ref);
  // A sale still waiting on KYC goes back to the provider's page, and its reads resume.
  if (
    current?.kind === "withdrawal" &&
    current.sale !== undefined &&
    saleAwaitingDeposit(current) &&
    current.status.kind === "awaiting-payment"
  ) {
    step.value = "kyc";
    followSale(ref);
  }
  void payWhenKnown();
});
onUnmounted(() => {
  alive = false;
  window.removeEventListener("message", onMessage);
  if (payRetry !== null) clearTimeout(payRetry);
  // The polls that follow the sale on screen stop; the record and the worker keep it.
  requests.leave();
});
</script>

<template>
  <!-- Toolbar and screen fill the visible viewport; the app never scrolls. -->
  <main
    class="fixed inset-x-0 mx-auto flex w-full max-w-md flex-col overflow-hidden bg-surface-main"
    style="
      top: var(--vvt, 0px);
      height: var(--vvh, 100dvh);
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
    "
  >
    <Toolbar :title="toolbar.title" :back="toolbar.back" @back="onBack">
      <template v-if="canSkipRail" #trailing>
        <button
          type="button"
          class="rounded-medium px-4 py-3 text-label-l font-normal text-fg-primary transition-colors hover:bg-action-tertiary-hover"
          @click="onSkipRail"
        >
          Skip
        </button>
      </template>
    </Toolbar>

    <!-- The provider's page runs edge to edge; every other step keeps the screen padding. -->
    <div class="flex min-h-0 flex-1 flex-col" :class="step === 'kyc' ? '' : 'px-6 pt-6'">
      <MeldSellKycScreen
        v-if="step === 'kyc' && widgetUrl"
        :widget-url="widgetUrl"
        :cancellable="cancellable"
        :cancelling="cancelling"
        :notice="notice"
        @cancel="cancelSale"
      />
      <MeldSellFeeDetailsScreen
        v-else-if="step === 'fees' && sale.quote.value"
        :quote="sale.quote.value"
        :cash-amount="amount"
        @back="step = 'quote'"
      />
      <CurrencySelectScreen
        v-else-if="step === 'region'"
        :options="pickerCountries"
        :model-value="sale.country.value"
        :detected="detectedCountry"
        placeholder="Search for a country"
        @pick="pickCountry"
      />
      <MeldSellQuoteScreen
        v-else-if="step === 'quote' || step === 'fees'"
        :amount="amount"
        :quote="sale.quote.value"
        :loading="sale.loading.value"
        :error="sale.error.value"
        :country="sale.country.value"
        :country-name="countryLabel"
        :starting="starting"
        :start-error="startError"
        @continue="confirm"
        @fees="step = 'fees'"
        @region="step = 'region'"
      />
      <WithdrawCancelScreen
        v-else-if="step === 'cancel'"
        :cancelling="cancelling"
        @confirm="cancelSale"
        @keep="closeCancel"
      />
      <WithdrawJourneyScreen
        v-else-if="(step === 'journey' || step === 'kyc') && record"
        :record="record"
        :notice="notice"
        :busy="busy"
        @cancel="openCancel"
        @retry="retry"
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
