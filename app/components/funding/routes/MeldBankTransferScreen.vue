<script setup lang="ts">
// The bank route's two steps, in one screen because they share one quote and one request.
//
// `summary` prices the transfer and asks the buyer to commit to it; `details` opens the provider's
// page, where the account to pay lives. The request is opened by Continue, not on arrival: a
// transfer nobody committed to would leave a payable page behind, and the key that opened it dies
// with it.
//
// Nothing here can see whether the transfer was actually made — the provider only learns of it
// when the money lands — so the screen stays on the details until the provider reports the payment
// moving, and the status poll hands the top-up to the journey. Back leaves it running in the list.
//
// A price that could not be had takes the summary step whole, in the two steps every quote
// screen shows: a retry, then a change of country or of rail.
import { computed, ref } from "vue";
import { ChevronRight, CircleAlert } from "lucide-vue-next";
import { methodMinimum, namedCountry, otherMethod } from "~~/lib/supported";
import { useRequestsStore } from "../../../stores/requests";
import { useSessionStore } from "../../../stores/session";
import { currencyConfig } from "../../../funding/config";
import { fmtFiat, isMoneyAmount } from "../../../utils/money";
import { fiatAmountRejected, fiatOutOfRange } from "../../../funding/out-of-range";
import type { FundingRoute } from "../../../funding/selection";
import CashAmount from "../../ui/CashAmount.vue";
import PillButton from "../../ui/PillButton.vue";
import RateErrorScreen from "../../ui/RateErrorScreen.vue";
import RegionRow from "../../ui/RegionRow.vue";
import ScreenFrame from "../../ui/ScreenFrame.vue";
import SkeletonBlock from "../../ui/SkeletonBlock.vue";
import AmountOutOfRange from "../AmountOutOfRange.vue";
import MethodUnavailable from "../MethodUnavailable.vue";
import MeldPaySheet from "./MeldPaySheet.vue";

const props = defineProps<{
  /** The region the quote is priced in, as an ISO 3166-1 alpha-2 code. */
  country: string;
  /** Which step is showing. The route owns it, so Back can step between them. */
  step: "summary" | "details";
  /** Offer a cancel under the confirmation. Set when the transfer was re-opened from the list:
   *  there the details are all the buyer came back for, and leaving is the other way out. */
  cancellable?: boolean;
}>();
// `fees` and `currency` open this route's drill-ins; `continue` asks the route for the details
// step; `switchRoute` asks the shell for another package when no transfer can be routed from here.
const emit = defineEmits<{
  fees: [];
  currency: [];
  continue: [];
  cancel: [];
  /** Leave the screen without touching the request: a lapsed transfer may still be arriving. */
  leave: [];
  switchRoute: [route: FundingRoute];
  changeAmount: [];
}>();

const session = useSessionStore();
const requests = useRequestsStore();

/** The quote failed. The method not routing from here is its own screen. */
const blocked = computed(() => session.quoteError !== null && !session.loading);
/** A request exists: the provider has a pay page for this quote. */
const requestOpen = computed(() => requests.phase !== null);
/** The summary has nothing to price yet. */
const pricing = computed(
  () =>
    !blocked.value &&
    session.quoteOutOfRange === null &&
    !session.quoteAmountRejected &&
    !session.quoted,
);

/** The hero: the exact total to transfer, fees included. Shown only once a quote priced it. */
const heroAmount = computed(() => {
  const q = session.quoted;
  return q ? fmtFiat(q.send, q.symbol) : null;
});
/** The caption drills into the breakdown only when the fee is a number it can split. */
const feesKnown = computed(() => isMoneyAmount(session.quoted?.fee));

/** The region the transfer is made from, named as the catalog names it. */
const countryLabel = computed(() => namedCountry(props.country, session.supportedCountries));

const starting = ref(false);
const startError = ref<string | null>(null);

/**
 * The provider no longer serves a page for this request: it is still live, but past the point
 * where it can be paid on, so there are no account details left to read and nothing to confirm.
 *
 * Only once the lookup has settled — a re-opened request has no URL until the adapter answers,
 * and calling that lapsed would accuse every resume of having expired.
 */
const lapsed = computed(
  () =>
    props.step === "details" &&
    requestOpen.value &&
    !starting.value &&
    !session.meldPayUrlPending &&
    session.meldPayUrl === null &&
    !requests.meldSubmitted,
);

/** Opens the request behind the details step. A resumed request already has one. */
async function openRequest() {
  if (starting.value || requestOpen.value || !session.quoted || blocked.value) return;
  starting.value = true;
  startError.value = null;
  try {
    await session.start();
  } catch (e) {
    console.warn("[meld] could not open the transfer:", e);
    startError.value =
      e instanceof Error ? e.message : "Could not open the transfer. Please try again.";
  } finally {
    starting.value = false;
  }
}
/** Commit: the details step opens while its request is being made, and shows its own progress. */
function onContinue() {
  emit("continue");
  void openRequest();
}

function requote() {
  startError.value = null;
  void session.fetchMeldQuote();
}
// Out of range: the bound the method takes, in CASH, becomes the amount and is quoted.
function useAmount(cash: string) {
  session.setAmount(cash);
  requote();
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <MethodUnavailable
      v-if="step === 'summary' && session.meldMethodUnavailable"
      direction="top-up"
      method="bank"
      :amount="session.amountHuman"
      :country="country"
      :country-name="countryLabel"
      :minimum="methodMinimum(session.meldCorridor, 'bank')"
      :other="otherMethod(session.meldCorridor, 'bank')"
      @region="emit('currency')"
      @use-crypto="emit('switchRoute', 'crypto')"
      @use-other="emit('switchRoute', 'card')"
    />
    <AmountOutOfRange
      v-else-if="step === 'summary' && session.quoteOutOfRange !== null && !session.loading"
      :amount="session.amountHuman"
      :words="fiatOutOfRange(session.quoteOutOfRange, 'bank', countryLabel)"
      :region="{ label: 'Payment country', value: countryLabel, country }"
      @region="emit('currency')"
      @change-amount="emit('changeAmount')"
      @use-amount="useAmount"
    />
    <AmountOutOfRange
      v-else-if="step === 'summary' && session.quoteAmountRejected && !session.loading"
      :amount="session.amountHuman"
      :words="fiatAmountRejected('bank', countryLabel)"
      :region="{ label: 'Payment country', value: countryLabel, country }"
      @region="emit('currency')"
      @change-amount="emit('changeAmount')"
    />
    <RateErrorScreen
      v-else-if="step === 'summary' && blocked"
      :failures="session.quoteFailures"
      @retry="requote"
      @change-country="emit('currency')"
      @use-crypto="emit('switchRoute', 'crypto')"
    />
    <ScreenFrame v-else-if="step === 'summary'">
      <!-- The hero, pricing or priced. -->
      <div class="flex shrink-0 flex-col items-center text-center">
        <template v-if="pricing">
          <SkeletonBlock class="h-16 w-40" />
          <SkeletonBlock class="mt-3 h-4 w-52" />
        </template>
        <template v-else>
          <p class="text-display-xl text-fg-primary">{{ heroAmount }}</p>
          <button
            v-if="feesKnown"
            type="button"
            class="flex items-center gap-2 text-body-m text-fg-secondary"
            @click="emit('fees')"
          >
            Send this exact amount inc. fees
            <ChevronRight class="size-4" aria-hidden="true" />
          </button>
          <p v-else class="text-body-m text-fg-secondary">Send this exact amount inc. fees</p>
        </template>
      </div>

      <div v-if="pricing" class="mt-6 flex flex-col gap-4">
        <div v-for="n in 4" :key="n" class="flex h-6 items-center justify-between">
          <SkeletonBlock class="h-4 w-2/5" />
          <SkeletonBlock class="h-4 w-1/5" />
        </div>
      </div>
      <div v-else class="mt-6 flex flex-col gap-4">
        <!-- The region the transfer is priced in, named by the currency it charges. -->
        <RegionRow
          label="Payment country"
          :value="countryLabel"
          :country="country"
          @open="emit('currency')"
        />

        <div class="flex items-baseline justify-between gap-4">
          <span class="text-paragraph-l text-fg-primary">You’ll receive</span>
          <span class="text-heading-m text-fg-primary">
            <CashAmount :amount="session.amountHuman" />
          </span>
        </div>

        <div class="flex items-start justify-between gap-4">
          <span class="text-paragraph-l text-fg-primary">Arrives</span>
          <span class="flex flex-col items-end text-right">
            <span class="text-heading-m text-fg-primary">1–2 business days</span>
            <span class="text-body-s text-fg-secondary">
              Final {{ currencyConfig.name }} depends on the rate on arrival
            </span>
          </span>
        </div>
      </div>

      <template #actions>
        <SkeletonBlock v-if="pricing" class="h-12 w-full" />
        <PillButton v-else class="w-full" @click="onContinue">Continue</PillButton>
        <PoweredBy provider="Meld" />
      </template>
    </ScreenFrame>

    <ScreenFrame v-else>
      <!-- The provider's page, and nothing of ours over it: the account to pay is on it. -->
      <div
        class="flex min-h-0 flex-1 flex-col overflow-clip rounded-container bg-surface-container"
      >
        <!-- Past the provider's page: say so, rather than embedding an empty frame. -->
        <div
          v-if="lapsed"
          class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
        >
          <CircleAlert class="size-8 text-fg-secondary" aria-hidden="true" />
          <p class="text-label-l font-semibold text-fg-primary">Transfer details expired</p>
          <p class="max-w-[260px] text-body-m text-fg-secondary">
            This transfer can no longer be paid. If you have already sent it, it will still arrive.
            Otherwise start a new top-up.
          </p>
        </div>
        <MeldPaySheet v-else-if="requestOpen && !startError" :pay-url="session.meldPayUrl" />
        <div
          v-else-if="!startError"
          class="flex-1 animate-pulse bg-action-disabled"
          aria-hidden="true"
        />
      </div>

      <p v-if="startError" class="mt-4 shrink-0 text-body-m text-fg-error">{{ startError }}</p>
      <p
        v-else-if="session.cancelNotice"
        class="mt-4 shrink-0 text-center text-body-m text-fg-secondary"
        role="status"
      >
        {{ session.cancelNotice }}
      </p>

      <template #actions>
        <div class="flex flex-col gap-3 pt-6">
          <PillButton v-if="startError" class="w-full" @click="openRequest">Try again</PillButton>
          <!-- Nothing left to confirm on a lapsed transfer, and nothing to cancel either: a
             transfer already sent still arrives, so this only leaves the screen. -->
          <PillButton v-else-if="lapsed" class="w-full" @click="emit('leave')">
            Back to top-ups
          </PillButton>
          <!-- A resumed transfer's way out: nothing can have been taken while this screen is up. -->
          <PillButton
            v-if="cancellable && !lapsed && !startError"
            variant="danger"
            class="w-full"
            @click="emit('cancel')"
          >
            Cancel
          </PillButton>
        </div>
      </template>
    </ScreenFrame>
  </div>
</template>
