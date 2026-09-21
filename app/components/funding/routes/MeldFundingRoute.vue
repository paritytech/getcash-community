<script setup lang="ts">
// Meld route for card and bank. Card picks the region, sees the quote, then pays inside the
// provider's widget. Bank prices the transfer first and opens its request on Continue, then shows
// the provider's details for the buyer to pay from their own banking app. Both hand off to the
// journey once the payment is approved, asserted, or fails.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { bankRailCountries } from "~~/lib/region";
import { countryName } from "~~/lib/supported";
import { useMeldHandoff } from "../../../composables/useMeldHandoff";
import { useStateDirector } from "../../../composables/useStateDirector";
import { useVisibilityReconcile } from "../../../composables/useVisibilityReconcile";
import { fundingSelectorConfig } from "../../../funding/config";
import { isDemoBuild } from "../../../utils/demo";
import { localeCountry } from "../../../utils/locale";
import type { FundingPackageEmits } from "../../../funding/handoff";
import type { FundingSelection } from "../../../funding/selection";
import { useFlowStore } from "../../../stores/flow";
import { useRequestsStore } from "../../../stores/requests";
import { useSessionStore } from "../../../stores/session";
import CurrencySelectScreen from "./CurrencySelectScreen.vue";
import MeldBankTransferScreen from "./MeldBankTransferScreen.vue";
import MeldFeeDetailsScreen from "./MeldFeeDetailsScreen.vue";
import MeldPayScreen from "./MeldPayScreen.vue";
import MeldPaySheet from "./MeldPaySheet.vue";

const props = defineProps<{ selection: FundingSelection }>();
const emit = defineEmits<FundingPackageEmits>();

const route = props.selection.route;
if (route !== "card" && route !== "bank") {
  throw new Error(`Meld cannot handle the ${route} route`);
}
const isBank = route === "bank";

const session = useSessionStore();
const requests = useRequestsStore();
const flow = useFlowStore();
useVisibilityReconcile();
const { previewLabel } = useStateDirector();
const { handedOff } = useMeldHandoff(emit);

// "Add funds via card" / "Add funds via bank": the toolbar names the whole action, since the
// screen below it no longer spells out the provider or the method.
const title = computed(() => {
  const label = fundingSelectorConfig.routes.find(({ id }) => id === route)?.label ?? route;
  return `Add funds via ${label.toLowerCase()}`;
});
/** The fee-breakdown drill-in over the pay screen. Back (toolbar or bottom button) returns to it. */
const showingFees = ref(false);
/** The region drill-in, bank only: which currency the transfer is made in. */
const showingCurrency = ref(false);
/** The bank route's two steps: the priced summary, then the provider's transfer details. */
const bankStep = ref<"summary" | "details">("summary");
// A cleared quote (re-quote, region change) leaves nothing to break down.
watch(
  () => session.quoted,
  (q) => {
    if (q) return;
    showingFees.value = false;
    // Re-quoting (a region change) prices a different transfer: the details behind it are gone,
    // so the step goes back to where that decision is made.
    bankStep.value = "summary";
  },
);
function goBack() {
  if (showingCurrency.value) showingCurrency.value = false;
  else if (showingFees.value) showingFees.value = false;
  // Back off the details is back to the summary; the request it opened stays, and Continue
  // returns to it rather than opening a second one.
  else if (bankStep.value === "details") bankStep.value = "summary";
  else emit("back");
}
/** The widget stage, card only: a request exists and the payment is still to be made. */
const paying = computed(() => !isBank && flow.screen === "journey");
// The widget supersedes the drill-in (its template branch wins). Without this, a flow that moves
// on while the fee screen is up leaves the flag set, and the next Back tap is silently spent
// clearing it instead of leaving.
watch(paying, (now) => {
  if (now) showingFees.value = false;
});
/** Cancel is offered only while nothing can have been paid. Card only: the bank screen has no
 *  cancel, so a transfer the buyer walks away from is left to the provider to expire. */
const canCancel = computed(
  () => paying.value && !requests.meldSubmitted && !requests.fundsSeen && !requests.claiming,
);

/** Performs the cancel. One that went through leaves for the selector; a declined one stays put. */
async function cancelTopUp() {
  if (await session.cancelTopUp()) emit("back");
}

/** The region the quote is priced in; matches what the picker shows as committed. */
const selectedCountry = computed(() => session.meldCountry ?? "DE");

/**
 * The regions a bank transfer can actually be made from: Meld has no generic bank code, so a
 * country without a rail is a dead end rather than a slower corridor. Named by the live catalog
 * where it has them, alphabetically, as the design lists them.
 */
const bankCountries = computed(() => {
  const named = new Map((session.supportedCountries ?? []).map((c) => [c.country, c.name]));
  return bankRailCountries()
    .map((country) => ({ country, name: named.get(country) ?? countryName(country) }))
    .sort((a, b) => a.name.localeCompare(b.name));
});
/** The device's own region, when a transfer can be made from it. */
const detectedCountry = computed(() => {
  const detected = localeCountry();
  return detected && bankRailCountries().includes(detected) ? detected : null;
});

/**
 * Commits a new region. A request already open for the old one is withdrawn first: its pay page
 * charges in the old currency, and leaving it served would let it be paid against a top-up the
 * buyer has moved on from. A refused cancel (a payment already on its way) keeps the old region,
 * and the store's notice says why.
 */
async function pickCurrency(country: string) {
  if (country === session.meldCountry) {
    showingCurrency.value = false;
    return;
  }
  if (requests.phase !== null && !(await session.cancelTopUp())) return;
  session.setMeldCountry(country);
  showingCurrency.value = false;
  // The bank screen opens the new request as soon as this quote lands.
  void session.fetchMeldQuote();
}

/**
 * Demo Skip: play the payment through from the start — the buyer leaving the widget, the provider
 * seeing the transaction, then settling it — so the timeline runs its whole length. The store
 * drives the deposit at the end of that, by faucet or by the mock harness.
 */
function onSkip() {
  session.simulateMeldPayment();
}

onMounted(() => {
  flow.startOver();
  session.setMethod(route);
  session.setAmount(props.selection.amount);
  // The bank route starts from a region that can quote it: the buyer's own where a transfer can be
  // made from it, else a SEPA one, until geolocation lands.
  if (isBank && session.meldCountry === null) session.setMeldCountry(detectedCountry.value ?? "DE");
  void import("~~/lib/host-chain").then((hostChain) => hostChain.prewarmChains());
  void session.fetchMeldQuote();
});
onUnmounted(() => {
  // After a handoff only this package's entry state is reset.
  if (handedOff()) flow.resetEntry();
  else flow.startOver();
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
    <!-- No title while the card widget is up; the back control stays. -->
    <Toolbar
      :title="paying ? '' : showingCurrency ? 'Choose a currency' : showingFees ? 'Fees' : title"
      :back="!requests.claiming && !session.resuming && !session.cancelling"
      @back="goBack"
    >
      <template
        v-if="
          (paying || isBank) &&
          isDemoBuild() &&
          !requests.claiming &&
          (session.canSkipDeposit || session.faucetState !== 'idle')
        "
        #trailing
      >
        <!-- Skip hides once tapped; a spinner takes its place until the deposit is seen. -->
        <button
          v-if="session.canSkipDeposit"
          type="button"
          class="rounded-medium px-4 py-3 text-label-l font-normal text-fg-primary transition-colors hover:bg-action-tertiary-hover"
          @click="onSkip"
        >
          Skip
        </button>
        <span
          v-else
          class="mx-4 my-3 inline-block size-6 animate-spin rounded-full border-[3px] border-stroke-primary border-t-fg-primary"
        />
      </template>
    </Toolbar>

    <!-- The screen padding is dropped while the card widget is up. -->
    <div class="flex min-h-0 flex-1 flex-col" :class="paying ? '' : 'px-6 pt-6'">
      <div v-if="session.resuming" class="flex flex-col items-center gap-4 pt-16">
        <span
          class="inline-block size-8 animate-spin rounded-full border-[3px] border-stroke-primary border-t-fg-primary"
        />
        <p class="text-body-m text-fg-secondary">Opening your top-up…</p>
      </div>
      <!-- Bank: both steps in one component, with the drill-ins laid over them. It stays mounted
           behind them — re-creating it would reload the provider's details page. -->
      <template v-else-if="isBank">
        <MeldFeeDetailsScreen v-if="showingFees" @back="showingFees = false" />
        <CurrencySelectScreen
          v-else-if="showingCurrency"
          :options="bankCountries"
          :model-value="selectedCountry"
          :detected="detectedCountry"
          :busy="session.cancelling"
          @pick="pickCurrency"
        />
        <MeldBankTransferScreen
          v-show="!showingFees && !showingCurrency"
          :country="selectedCountry"
          :step="bankStep"
          @fees="showingFees = true"
          @currency="showingCurrency = true"
          @continue="bankStep = 'details'"
          @switch-route="emit('switchRoute', $event)"
        />
      </template>
      <template v-else-if="paying">
        <MeldPaySheet :pay-url="session.meldPayUrl" />
        <button
          v-if="canCancel"
          type="button"
          class="mx-6 mt-3 mb-4 h-12 shrink-0 rounded-medium bg-status-error text-label-l text-fg-static-white transition-colors hover:bg-status-error-hover disabled:opacity-50"
          :disabled="session.cancelling || !session.cancelReady"
          @click="cancelTopUp"
        >
          {{ session.cancelling ? "Cancelling…" : "Cancel" }}
        </button>
        <p
          v-if="session.cancelNotice"
          class="mx-6 mb-4 text-center text-body-m text-fg-secondary"
          role="status"
        >
          {{ session.cancelNotice }}
        </p>
      </template>
      <MeldFeeDetailsScreen v-else-if="showingFees" @back="showingFees = false" />
      <MeldPayScreen
        v-else
        @fees="showingFees = true"
        @switch-route="emit('switchRoute', $event)"
      />
    </div>

    <!-- state-director scene label (dev/demo keys only) -->
    <span
      v-if="previewLabel"
      class="fixed bottom-2 left-2 rounded-small bg-surface-container px-2 py-1 font-mono text-overline text-fg-secondary shadow-1"
    >
      {{ previewLabel }}
    </span>
  </main>
</template>
