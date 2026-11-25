<script setup lang="ts">
// The journey route: the finish of a top-up from a confirmed deposit to CASH in the balance.
// Reached
// from a package's handoff or from a top-up opened from the list.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { RecoveryToken } from "@getsome/funding";
import { useFundingProgressClock } from "../../composables/useFundingProgressClock";
import { usePurseBalance } from "../../composables/usePurseBalance";
import { useScreen } from "../../composables/useScreen";
import { useStateDirector } from "../../composables/useStateDirector";
import { useVisibilityReconcile } from "../../composables/useVisibilityReconcile";
import { recoveryChoices } from "../../funding/recovery-deposit";
import { burnerAddressOf, depositGone, isDirectDeposit } from "../../funding/requests/model";
import { directDepositDropped } from "../../funding/requests/views";
import { TIMELINE_CADENCE_MS } from "../../funding/timeline/timelines";
import {
  awaitingAnswer,
  recoveryFee,
  recoveryPrompt,
  trappedCash,
  type PurseWord,
} from "../../funding/timeline/recovery";
import type { FundingTopUp } from "../../funding/top-ups";
import { useFlowStore } from "../../stores/flow";
import { useRequestsStore } from "../../stores/requests";
import { useSessionStore } from "../../stores/session";
import { fmtCash } from "../../utils/cash";
import { isDemoBuild } from "../../utils/demo";
import { requestRefKey } from "../../utils/request-index";
import CancelTopUpScreen from "../screens/CancelTopUpScreen.vue";
import DepositScreen from "../screens/DepositScreen.vue";
import JourneySkeleton from "../screens/JourneySkeleton.vue";
import ScreenShell from "../ui/ScreenShell.vue";
import RecoverDepositScreen from "../screens/RecoverDepositScreen.vue";
import RecoverFeeScreen from "../screens/RecoverFeeScreen.vue";
import RecoverTokenScreen from "../screens/RecoverTokenScreen.vue";
import RecoverTrappedScreen from "../screens/RecoverTrappedScreen.vue";
import ReturnFundsScreen from "../screens/ReturnFundsScreen.vue";
import FundingSettledStatusScreen from "./FundingSettledStatusScreen.vue";
import { useJourneyQuote } from "../../composables/useJourneyQuote";
import MeldFeeDetailsScreen from "./routes/MeldFeeDetailsScreen.vue";
import { devLog } from "~~/lib/log";
import { trackAction } from "~~/lib/telemetry";

const props = defineProps<{
  title: string;
  /** The top-up as the list knows it; null after a handoff. Its stored timeline is the fallback
   *  while the request is not live in the store. */
  topUp?: FundingTopUp | null;
  /** Brings `topUp` to the foreground; null after a handoff. */
  open?: ((topUp: FundingTopUp) => Promise<boolean>) | null;
}>();
// startOver bubbles up from a fiat top-up that ended: the host re-enters its package with the same
// amount.
const emit = defineEmits<{ back: []; startOver: [] }>();

const session = useSessionStore();
const requests = useRequestsStore();
const flow = useFlowStore();
// A settled top-up is read from the list only: nothing resumed, nothing reset on the way out.
const readOnly = props.topUp?.state.kind === "settled";
const opening = ref(!readOnly && props.topUp != null && props.open != null);
/** The request could not be brought to the foreground — an old top-up whose world is gone. */
const unresumable = ref(false);
/** Nothing left to show at all: not resumable, and no stored record to fall back on. */
const unavailable = computed(() => unresumable.value && props.topUp == null);
// Waiting on the record: this screen's own open, or a resume the store started under it (a
// reconcile on return from the background brings one back the same way).
const waiting = computed(
  () =>
    (opening.value || session.resuming) && requests.foregroundRecord === null && !unresumable.value,
);
let active = true;

useVisibilityReconcile();
useStateDirector();

/** The fee-breakdown drill-in over the journey. Back (toolbar or bottom button) returns to it. */
const showingFees = ref(false);
// The quote the journey's money row was built from, so the row and the breakdown behind its
// chevron cannot disagree about what the buyer paid.
const { quote, cashAmount } = useJourneyQuote(
  () => props.topUp,
  () => readOnly,
);
// A quote gone from both the session and the record leaves nothing to break down.
watch(quote, (q) => {
  if (!q) showingFees.value = false;
});
/** The return-funds drill-in over a refunded journey. Back (toolbar or bottom button) returns. */
const showingRefund = ref(false);
// A live state that is no longer failed has no refund to walk through. A journey opened from
// history has no live state at all, and its guide is driven by the record instead, so the guard
// only applies while a request is actually on screen.
watch(
  () => requests.phase,
  (phase) => {
    if (phase !== null && phase !== "failed") showingRefund.value = false;
  },
);
/** The recovery guide over an ended Polkadot top-up, whose funds, if any, are on its own
 *  account. */
const showingRecovery = ref(false);

/** The screens over a top-up whose Cash is in People's trap: the fee's confirmation before the
 *  purse is asked, the token to send instead, and the deposit on that token. Back (toolbar or
 *  bottom button) returns to the journey; Change token returns to the token screen. */
type RecoveryScreen = "fee" | "token" | "deposit";
const recoveryScreen = ref<RecoveryScreen | null>(null);
const recovering = computed(() => requests.foregroundRecord?.status.kind === "recovering");
// The purse is read for a top-up in recovery only: whether it covers the fee decides what the
// band offers, and the confirmation shows it. The deck stages a balance of its own.
const purse = usePurseBalance({ enabled: () => recovering.value });
const purseWord = computed<PurseWord>(() => {
  if (isDemoBuild() && flow.previewPurse !== null) return flow.previewPurse;
  const state = purse.state.value;
  if (state.kind === "known") return state.balance;
  return state.kind === "unknown" && purse.failed.value ? "unread" : state.kind;
});
/** The claim's fee as the confirmation shows it, once the worker sized it, and as the band and
 *  the deposit screen name it. */
const recoveryFeeHuman = computed(() => {
  const ask = requests.foregroundRecord?.recovery?.askCash;
  return ask === undefined ? null : fmtCash(BigInt(ask));
});
const recoveryFeeText = computed(() => {
  const record = requests.foregroundRecord;
  return record === null ? undefined : recoveryFee(record);
});
/** The read purse falls short of the fee: the confirmation says so and does not ask the host. */
const purseShort = computed(() => {
  const ask = requests.foregroundRecord?.recovery?.askCash;
  return typeof purseWord.value === "bigint" && ask !== undefined && purseWord.value < BigInt(ask);
});
/** The Cash the claim adds, as the confirmation names it. */
const recoveryAmount = computed(() => {
  const record = requests.foregroundRecord;
  return record === null ? "" : trappedCash(record);
});
/** What the deposit screen shows: the record's own address, and the tokens as the worker priced
 *  them. */
const recoveryAddress = computed(() => {
  const record = requests.foregroundRecord;
  return record === null ? null : burnerAddressOf(record);
});
const recoveryPriced = computed(() => requests.foregroundRecord?.recovery?.minimums !== undefined);
const recoveryChoicesView = computed(() => recoveryChoices(requests.foregroundRecord?.recovery));
/** The token the deposit screen is on: picked here, else as the record remembers it. A pick
 *  belongs to the record it was made on, and goes with it. */
const pickedToken = ref<RecoveryToken | null>(null);
/** Whether the record on screen was given its chance to open on the deposit screen. */
let landingDecided = false;
watch(
  () => {
    const record = requests.foregroundRecord;
    return record === null ? null : requestRefKey(record.ref);
  },
  () => {
    pickedToken.value = null;
    landingDecided = false;
    // A recovery screen shows one record's figures: none carries over to the next.
    recoveryScreen.value = null;
  },
);
const depositToken = computed(
  () => pickedToken.value ?? requests.foregroundRecord?.recovery?.depositToken ?? null,
);
const depositChoice = computed(
  () => recoveryChoicesView.value.find((c) => c.token === depositToken.value) ?? null,
);
// The same order as the template's switch.
useScreen(() => {
  if (readOnly && props.topUp && !showingFees.value) return "top-up.settled";
  if (waiting.value || unavailable.value) return null;
  if (flow.confirmingCancel) return "top-up.cancel";
  if (showingRefund.value) return "top-up.refund";
  if (showingRecovery.value) return "top-up.recover-deposit";
  if (recoveryScreen.value === "fee" && recoveryFeeHuman.value !== null)
    return "top-up.recover-fee";
  if (recoveryScreen.value === "token") return "top-up.recover-token";
  if (recoveryScreen.value === "deposit" && depositToken.value !== null) {
    return "top-up.recover-trapped";
  }
  if (showingFees.value) return "fees";
  if (depositAgain.value) {
    return flow.recoveringDeposit ? "top-up.recover-deposit" : "top-up.deposit";
  }
  return "top-up.journey";
});
/** The host's word on the fee's payment. */
const payment = computed(() => requests.foregroundRecord?.recovery?.payment);
/** The host is being asked, or its sheet is up: the confirmation says the fee is being paid. The
 *  band reads the same predicate for its waiting line. */
const asking = ref(false);
const payingFee = computed(
  () => asking.value || awaitingAnswer(requests.foregroundRecord?.recovery),
);
/** The band's word on the recovery, read with the purse as the journey reads it. */
const prompt = computed(() => {
  const record = requests.foregroundRecord;
  return record === null ? undefined : recoveryPrompt(record, purseWord.value);
});
// The buyer is still asked for the fee: the trap stands, nothing is being converted or claimed,
// and no payment is on its way. Otherwise the screens close, so they cannot ask for a second
// deposit or a second fee; the confirmation stays while its own payment is on its way.
const recoveryAsksTheBuyer = computed<boolean | null>(() => {
  if (requests.foregroundRecord === null) return null;
  return (prompt.value?.actions.length ?? 0) > 0;
});
watch(recoveryAsksTheBuyer, (asks) => {
  if (asks !== false) return;
  if (recoveryScreen.value === "fee" && payingFee.value && recovering.value) return;
  recoveryScreen.value = null;
});
// A record that is no longer recovering has no recovery screen to show, whatever was up.
watch(recovering, (on) => {
  if (!on) recoveryScreen.value = null;
});
/** The host's answer closes the confirmation: the fee is paid, or the journey says why not. The
 *  purse is read again: afresh when it paid, in part or whole, since the answer drew it down;
 *  with the known balance standing meanwhile when it refused or did not know the ask. */
watch(
  () => payment.value?.status,
  (status) => {
    if (status === undefined) return;
    if (recoveryScreen.value === "fee") recoveryScreen.value = null;
    const spent =
      status === "processing" || status === "completed" || status === "partiallyClaimed";
    void purse.refresh({ spent });
  },
);
// The confirmation shows the balance, so it opens on a fresh read.
watch(recoveryScreen, (screen) => {
  if (screen === "fee") void purse.refresh();
});
// A screen whose figures are gone closes: the fee re-sized under the confirmation, or the
// deposit without a token.
watch(
  () =>
    (recoveryScreen.value === "fee" && recoveryFeeHuman.value === null) ||
    (recoveryScreen.value === "deposit" && depositToken.value === null),
  (gone) => {
    if (gone) recoveryScreen.value = null;
  },
);
// A top-up whose deposit screen was opened before opens on it again, decided once per record as
// soon as the purse is read: onto the QR only while the band offers the wallet path then, not
// onto one it would not offer, as when the purse covers the fee since, and not over the band's
// word that a deposit was let go, which the buyer should read before being asked for another.
// Decided once and at once, so neither a later read nor a band that only asks later, after a
// refusal or a failed claim the buyer is reading about, moves them there unasked; not before the
// first read lands, since until then the band offers the purse alone and the buyer whose balance
// falls short would never land. Never over another screen the buyer has opened meanwhile.
watch(
  () => {
    const record = requests.foregroundRecord;
    if (record === null || !recovering.value || purseWord.value === "unknown") return null;
    return requestRefKey(record.ref);
  },
  (key) => {
    if (key === null || landingDecided) return;
    landingDecided = true;
    const wallet = prompt.value?.actions.some((action) => action.kind === "send-deposit") === true;
    const unused = requests.foregroundRecord?.recovery?.depositUnused !== undefined;
    const clear =
      recoveryScreen.value === null &&
      !showingFees.value &&
      !showingRefund.value &&
      !showingRecovery.value &&
      !flow.confirmingCancel;
    if (wallet && !unused && depositToken.value !== null && clear) {
      recoveryScreen.value = "deposit";
    }
  },
  { immediate: true },
);
/** The deposit path: the token screen first, the deposit itself once a token is known. */
function openRecoveryDeposit() {
  recoveryScreen.value = depositToken.value === null ? "token" : "deposit";
}
/** The pick opens the deposit on the token and is kept on the record, so the top-up opens on the
 *  deposit again. A pick that could not be kept still opens the deposit; it is only not
 *  remembered. */
async function pickRecoveryToken(token: RecoveryToken) {
  const record = requests.foregroundRecord;
  if (record === null) return;
  pickedToken.value = token;
  recoveryScreen.value = "deposit";
  try {
    await requests.pickRecoveryToken(record.ref, token);
  } catch (e) {
    devLog("funding", `the recovery token could not be kept: ${String(e)}`, undefined, "warn");
  }
}

/** A tap on the purse the store could not act on: said on the confirmation, until the record
 *  moves or the buyer taps again. */
const recoveryNotice = ref<string | null>(null);
watch(
  () => requests.foregroundRecord?.rev,
  () => {
    recoveryNotice.value = null;
  },
);
/** Asks the purse for the claim's fee. A refusal reaches the journey as the host's word; a request
 *  that could not be made is said on the confirmation, its offer standing for the next tap. */
async function recoverFromBalance() {
  const record = requests.foregroundRecord;
  if (record === null) return;
  trackAction("recover.from-balance");
  recoveryNotice.value = null;
  asking.value = true;
  try {
    const asked = await requests.requestRecoveryPayment(record.ref);
    if (!asked.ok) recoveryNotice.value = asked.reason;
  } catch (e) {
    // The stamp or the host could not be reached: said, and the offer stands for the next tap.
    devLog("funding", `the recovery fee could not be asked for: ${String(e)}`, undefined, "warn");
    recoveryNotice.value = "Your balance couldn't be asked just now. Try again in a moment.";
  } finally {
    asking.value = false;
  }
}
// Demo deck: a scene can land straight on an opened drill-in. Inert everywhere else.
if (isDemoBuild()) {
  watch(
    () => flow.previewDrillIn,
    (want) => {
      if (want === "refund") showingRefund.value = true;
      else if (want === "recovery-fee") recoveryScreen.value = "fee";
      else if (want === "recovery-token") recoveryScreen.value = "token";
      else if (want === "recovery-deposit") recoveryScreen.value = "deposit";
    },
    { immediate: true },
  );
}

// The cancel confirmation over the journey, asked for by the bank transfer's Cancel. It is the
// flow store's flag, as the crypto deposit's confirmation is: one place holds "a cancel is being
// confirmed", and the preview deck can stage it.
// A request past the point of cancelling takes the confirmation down with it: the money arrived
// while it was up, and the choice it offers is no longer there to make.
watch(
  () => requests.fundsSeen || requests.claiming,
  (paid) => {
    if (paid) flow.confirmingCancel = false;
  },
);

/** The clock that turns a dropped direct deposit back into the deposit screen; it runs only while
 *  a deposit is gone. */
const now = useFundingProgressClock(() => {
  const record = requests.foregroundRecord;
  return record !== null && depositGone(record) ? TIMELINE_CADENCE_MS : null;
});
/** The network dropped the buyer's own transfer long enough ago that it will not land: the journey
 *  asks for it again where it was first asked. It stays there once something the buyer sent since
 *  is on the account short of the deposit, which ends the wait for the one that left. */
const depositAgain = computed(() => {
  const record = requests.foregroundRecord;
  if (record === null || !isDirectDeposit(record)) return false;
  if (record.status.kind !== "awaiting-deposit") return false;
  return directDepositDropped(record, now.value) || !depositGone(record);
});
// The deposit's way back closes with the deposit screen: the rest of a short deposit landed, or
// the request ended.
watch(depositAgain, (again) => {
  if (!again) flow.recoveringDeposit = false;
});

/** The toolbar's title: the drill-ins name themselves, the live journey carries none. */
const shellTitle = computed(() => {
  if (showingFees.value) return "Fees";
  if (recoveryScreen.value === "token") return "Select token";
  if (recoveryScreen.value === "deposit") return "Pay fee";
  return waiting.value || unresumable.value ? props.title : "";
});

function goBack() {
  if (flow.confirmingCancel) flow.confirmingCancel = false;
  else if (flow.recoveringDeposit) flow.recoveringDeposit = false;
  else if (showingRefund.value) showingRefund.value = false;
  else if (showingRecovery.value) showingRecovery.value = false;
  else if (recoveryScreen.value !== null) recoveryScreen.value = null;
  else if (showingFees.value) showingFees.value = false;
  else emit("back");
}

/** Performs the cancel. One that went through leaves the way any other exit does — to the list the
 *  top-up was opened from, or the shell for a purchase that had none; a declined one returns to the
 *  journey, where the store's notice says why. */
async function cancelTopUp() {
  if (await session.cancelTopUp()) emit("back");
  else flow.confirmingCancel = false;
}

onMounted(async () => {
  if (!opening.value || !props.topUp || !props.open) return;
  let opened = false;
  try {
    opened = await props.open(props.topUp);
  } catch (e) {
    devLog("funding", "could not open the top-up", e, "warn");
    opened = false;
  } finally {
    if (active) {
      unresumable.value = !opened;
      opening.value = false;
    }
  }
  if (!active && opened) session.reset();
});

onUnmounted(() => {
  active = false;
  // The confirmation and the deposit's way back belong to this screen; leaving must not carry them
  // to the next one.
  flow.confirmingCancel = false;
  flow.recoveringDeposit = false;
  if (!readOnly) session.reset();
});
</script>

<template>
  <!-- The live journey's toolbar is back-only; the fee and recovery drill-ins take it over
       while open. Back stays available during the claim: leaving lands on the top-ups list,
       where the in-flight top-up remains resumable. -->
  <ScreenShell
    :title="shellTitle"
    :back="(readOnly || !waiting) && !session.cancelling"
    @back="goBack"
  >
    <FundingSettledStatusScreen
      v-if="readOnly && topUp && !showingFees"
      :top-up="topUp"
      @fees="showingFees = true"
      @close="emit('back')"
    />

    <!-- The screen's own shapes while the request opens, not a spinner over an empty one. -->
    <JourneySkeleton v-else-if="waiting" :timeline="!readOnly" />

    <div v-else-if="unavailable" class="flex flex-1 flex-col items-center pt-16 text-center">
      <h1 class="text-heading-l text-fg-primary">Top-up unavailable</h1>
      <p class="mt-2 text-body-m text-fg-secondary">
        This top-up is no longer available. Return to see your latest activity.
      </p>
    </div>

    <CancelTopUpScreen
      v-else-if="flow.confirmingCancel"
      :kind="requests.foregroundRecord?.route === 'crypto' ? 'deposit' : 'transfer'"
      @confirm="cancelTopUp"
      @keep="flow.confirmingCancel = false"
    />
    <ReturnFundsScreen v-else-if="showingRefund" :top-up="topUp" @back="showingRefund = false" />
    <RecoverDepositScreen v-else-if="showingRecovery" @back="showingRecovery = false" />
    <RecoverFeeScreen
      v-else-if="recoveryScreen === 'fee' && recoveryFeeHuman !== null"
      :fee="recoveryFeeHuman"
      :amount="recoveryAmount"
      :purse="purseWord"
      :short="purseShort"
      :paying="payingFee"
      :notice="recoveryNotice"
      @confirm="recoverFromBalance"
      @back="recoveryScreen = null"
    />
    <RecoverTokenScreen
      v-else-if="recoveryScreen === 'token'"
      :choices="recoveryChoicesView"
      :priced="recoveryPriced"
      @pick="pickRecoveryToken"
      @back="recoveryScreen = null"
    />
    <RecoverTrappedScreen
      v-else-if="recoveryScreen === 'deposit' && depositToken !== null"
      :address="recoveryAddress"
      :choice="depositChoice"
      :fee="recoveryFeeText"
      @change-token="recoveryScreen = 'token'"
    />
    <MeldFeeDetailsScreen
      v-else-if="showingFees"
      :quote="quote"
      :cash-amount="cashAmount"
      @back="showingFees = false"
    />
    <DepositScreen v-else-if="depositAgain" @cancel="flow.confirmingCancel = true" />
    <template v-else>
      <JourneyScreen
        :top-up="topUp ?? null"
        :purse="purseWord"
        @fees="showingFees = true"
        @refund="showingRefund = true"
        @recover="showingRecovery = true"
        @recover-from-balance="recoveryScreen = 'fee'"
        @recover-deposit="openRecoveryDeposit"
        @cancel="flow.confirmingCancel = true"
        @close="emit('back')"
        @start-over="emit('startOver')"
      />
      <!-- A cancel the adapter refused: the payment is already on its way and the request
           stands. -->
      <p
        v-if="session.cancelNotice"
        class="shrink-0 pb-cta text-center text-body-m text-fg-secondary"
        role="status"
      >
        {{ session.cancelNotice }}
      </p>
    </template>
  </ScreenShell>
</template>
