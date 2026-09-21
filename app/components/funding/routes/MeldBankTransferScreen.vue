<script setup lang="ts">
// The bank route's two steps, in one screen because they share one quote and one request.
//
// `summary` prices the transfer and asks the buyer to commit to it; `details` opens the provider's
// page, where the account to pay lives. The request is opened by Continue, not on arrival: a
// transfer nobody committed to would leave a payable page behind, and the key that opened it dies
// with it.
//
// Nothing here can see whether the transfer was actually made — the provider only learns of it
// when the money lands — so "I've sent funds" is the buyer's word. It waits out a short countdown
// first, because the details behind it take longer to read than the button takes to reach.
import { computed, onUnmounted, ref, watch } from "vue";
import { ChevronRight, CircleAlert } from "lucide-vue-next";
import { regionForCountry } from "~~/lib/region";
import { useRequestsStore } from "../../../stores/requests";
import { useSessionStore } from "../../../stores/session";
import { cashAmount } from "../../../utils/cash";
import { currencyName } from "../../../utils/currency";
import { fmtFiat, isMoneyAmount } from "../../../utils/money";
import type { FundingRoute } from "../../../funding/selection";
import PillButton from "../../ui/PillButton.vue";
import RegionRow from "../../ui/RegionRow.vue";
import SkeletonBlock from "../../ui/SkeletonBlock.vue";
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
}>();

const session = useSessionStore();
const requests = useRequestsStore();

/** No quote, or one that cannot be paid from here. */
const blocked = computed(() => session.meldMethodUnavailable || session.quoteError !== null);
/** A request exists: the provider has a pay page for this quote. */
const requestOpen = computed(() => requests.phase !== null);
/** The summary has nothing to price yet. */
const pricing = computed(() => !blocked.value && !session.quoted);

/** The fiat the screen is denominated in. Known from the region even when no quote priced it. */
const fiat = computed(() => session.quoted?.symbol ?? regionForCountry(props.country).fiat);
/** The hero: the exact total to transfer, fees included; zeroed when there is no quote. */
const heroAmount = computed(() => {
  const q = session.quoted;
  return q ? fmtFiat(q.send, q.symbol) : fmtFiat("0", fiat.value);
});
/** The caption drills into the breakdown only when the fee is a number it can split. */
const feesKnown = computed(() => isMoneyAmount(session.quoted?.fee));

const currencyLabel = computed(() => currencyName(fiat.value));

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

/** Bank is not routed from this region: offer card if the corridor has it, else crypto. */
const cardAvailable = computed(() =>
  (session.meldCorridor?.methods ?? []).some((m) => m.category === "card"),
);
/**
 * The line under the zeroed hero. A quote that failed can be asked for again; a region that routes
 * no transfer cannot, and says so instead of inviting a retry that would fail the same way.
 */
const blockedText = computed(() =>
  session.meldMethodUnavailable
    ? "Bank transfer isn't available in this region"
    : "Error fetching quote, retry again",
);

/** How long the confirmation waits, in seconds, from the moment the details are on screen. */
const CONFIRM_DELAY_S = 5;
/** Seconds still to wait; 0 once the confirmation is the buyer's to give. */
const countdown = ref(CONFIRM_DELAY_S);
let countdownTimer: ReturnType<typeof setInterval> | null = null;
function stopCountdown() {
  if (countdownTimer !== null) clearInterval(countdownTimer);
  countdownTimer = null;
}
/** Runs once per pay page: a page that reloads under the buyer does not restart their wait. */
function startCountdown() {
  if (countdownTimer !== null || countdown.value === 0) return;
  countdownTimer = setInterval(() => {
    countdown.value -= 1;
    if (countdown.value <= 0) stopCountdown();
  }, 1_000);
}
watch(
  () => props.step === "details" && session.meldPayUrl !== null,
  (showing) => {
    if (showing) startCountdown();
  },
  { immediate: true },
);
onUnmounted(stopCountdown);

/**
 * The buyer's word that the transfer is on its way. The provider cannot see an inbound transfer
 * until it lands, so this is the same handoff the card widget posts for itself: it moves the
 * top-up onto the journey, where the status poll takes over.
 */
const canConfirm = computed(
  () =>
    countdown.value === 0 &&
    !requests.meldSubmitted &&
    session.meldPayUrl !== null &&
    !requests.claiming,
);
function confirmSent() {
  if (!canConfirm.value) return;
  void session.markMeldSubmitted();
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <template v-if="step === 'summary'">
      <!-- The hero, in each of its three states: pricing, unpriced, priced. -->
      <div class="flex shrink-0 flex-col items-center text-center">
        <template v-if="pricing">
          <SkeletonBlock class="h-16 w-40" />
          <SkeletonBlock class="mt-3 h-4 w-52" />
        </template>
        <template v-else-if="blocked">
          <p class="text-display-xl text-fg-disabled">{{ heroAmount }}</p>
          <p class="mt-1 flex items-center gap-1 text-body-m text-fg-error">
            <CircleAlert class="size-4 shrink-0" aria-hidden="true" />
            {{ blockedText }}
          </p>
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
        <div v-for="n in 3" :key="n" class="flex h-6 items-center justify-between">
          <SkeletonBlock class="h-4 w-2/5" />
          <SkeletonBlock class="h-4 w-1/5" />
        </div>
      </div>
      <div v-else class="mt-6 flex flex-col gap-4">
        <!-- The region the transfer is priced in, named by the currency it charges. Live even
             while blocked: changing it is the other way out. -->
        <RegionRow
          label="Paying with"
          :value="currencyLabel"
          :country="country"
          @open="emit('currency')"
        />

        <div class="flex items-baseline justify-between gap-4">
          <span class="text-paragraph-l text-fg-primary">You’ll receive</span>
          <span v-if="blocked" class="text-heading-m text-fg-disabled">{{ cashAmount("0") }}</span>
          <span v-else class="text-heading-m text-fg-primary">
            {{ cashAmount(session.amountHuman) }}
          </span>
        </div>

        <!-- Nothing is arriving while there is no quote, so the row goes with it. -->
        <div v-if="!blocked" class="flex items-start justify-between gap-4">
          <span class="text-paragraph-l text-fg-primary">Arrives</span>
          <span class="flex flex-col items-end text-right">
            <span class="text-heading-m text-fg-primary">1–2 business days</span>
            <span class="text-body-s text-fg-secondary">
              Final $CASH depends on the rate on arrival
            </span>
          </span>
        </div>
      </div>

      <!-- Blocked, the button is the way out of the state; otherwise it commits to the transfer. -->
      <PillButton
        v-if="blocked"
        variant="secondary"
        class="mt-auto mb-6 w-full shrink-0"
        @click="
          session.meldMethodUnavailable
            ? emit('switchRoute', cardAvailable ? 'card' : 'crypto')
            : requote()
        "
      >
        {{
          session.meldMethodUnavailable
            ? cardAvailable
              ? "Use card instead"
              : "Use crypto instead"
            : "Retry quote"
        }}
      </PillButton>
      <SkeletonBlock v-else-if="pricing" class="mt-auto mb-6 h-12 w-full shrink-0" />
      <PillButton v-else class="mt-auto mb-6 w-full shrink-0" @click="onContinue">
        Continue
      </PillButton>
    </template>

    <template v-else>
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

      <div class="mt-6 mb-6 flex shrink-0 flex-col gap-3">
        <PillButton v-if="startError" class="w-full" @click="openRequest">Try again</PillButton>
        <!-- Nothing left to confirm on a lapsed transfer, and nothing to cancel either: a
             transfer already sent still arrives, so this only leaves the screen. -->
        <PillButton v-else-if="lapsed" class="w-full" @click="emit('leave')">
          Back to top-ups
        </PillButton>
        <!-- The count is on the button, so the wait is visibly the button's and not a failure. -->
        <PillButton v-else class="w-full" :disabled="!canConfirm" @click="confirmSent">
          <!-- A non-breaking space: the compiler condenses a plain one away, and the count must
               not wrap off the label either. -->
          I’ve sent funds<template v-if="countdown > 0">&nbsp;{{ countdown }}</template>
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
  </div>
</template>
