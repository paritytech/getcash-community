<script setup lang="ts">
// The crypto withdrawal package: network, token, address and summary, then the journey once the
// purse was asked. Opened from the list with `topUp`, it goes straight to the journey of that
// record. The record and the worker carry on when this screen is left.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useWithdrawalRequest } from "../../../composables/useWithdrawalRequest";
import type { FundingPackageEmits } from "../../../funding/handoff";
import type { FundingSelection } from "../../../funding/selection";
import type { FundingTopUp } from "../../../funding/top-ups";
import { useRequestsStore } from "../../../stores/requests";
import { useWithdrawOffersStore } from "../../../stores/withdraw-offers";
import { toCashBase } from "../../../utils/cash";
import { isDemoBuild } from "../../../utils/demo";
import {
  landingAccountHex,
  type WithdrawDestination,
  type WithdrawNetwork,
} from "../../../withdraw/destinations";
import { withdrawalRequestRef } from "../../../withdraw/rows";
import Toolbar from "../../ui/Toolbar.vue";
import WithdrawAddressScreen from "../WithdrawAddressScreen.vue";
import WithdrawCancelScreen from "../WithdrawCancelScreen.vue";
import WithdrawJourneyScreen from "../WithdrawJourneyScreen.vue";
import WithdrawNetworkScreen from "../WithdrawNetworkScreen.vue";
import WithdrawSummaryScreen from "../WithdrawSummaryScreen.vue";
import WithdrawTokenScreen from "../WithdrawTokenScreen.vue";

const props = defineProps<{
  /** A fresh withdrawal: the amount the shell took. */
  selection?: FundingSelection | null;
  /** A withdrawal opened from the list. */
  topUp?: FundingTopUp | null;
}>();
const emit = defineEmits<FundingPackageEmits>();

if (props.selection && props.selection.route !== "crypto") {
  throw new Error(`the crypto withdrawal cannot handle the ${props.selection.route} route`);
}

const requests = useRequestsStore();
const withdrawal = useWithdrawalRequest();

type Step = "network" | "token" | "address" | "summary" | "journey" | "cancel";
const step = ref<Step>(props.topUp ? "journey" : "network");
const network = ref<WithdrawNetwork | null>(null);
const destination = ref<WithdrawDestination | null>(null);
const address = ref("");
/** What arrives, formatted; null while quoting; undefined without a quote. */
const receive = ref<string | null | undefined>(undefined);
/** The native the estimate is for; what a provider's channel is quoted with at confirm. */
const expectedNative = ref<bigint | null>(null);
const starting = ref(false);
const startError = ref<string | null>(null);
const busy = ref(false);
const notice = ref<string | null>(null);

const record = computed(() => requests.foregroundWithdrawal);
const amount = computed(() => props.selection?.amount ?? props.topUp?.amount ?? "");
/** The amount in base units; null while the shell's string cannot be read. */
const amountBase = computed(() => toCashBase(amount.value));
const offers = useWithdrawOffersStore();
/** A withdrawal opened from the list whose record the store no longer has. */
const unavailable = computed(() => {
  if (!props.topUp || record.value !== null) return false;
  const ref = withdrawalRequestRef(props.topUp.id);
  return ref === null || !requests.has(ref);
});

/** Demo Skip: the provider's channel is real on a test network but can never be paid there, so
 *  the swap is taken as delivered by hand and the walk can reach its end. */
const canSkipRail = computed(
  () =>
    isDemoBuild() &&
    step.value === "journey" &&
    record.value?.status.kind === "sending" &&
    record.value.rail.provider !== "direct",
);

function onSkipRail() {
  const current = record.value;
  if (current === null || busy.value) return;
  void withdrawal.skipRail(current.ref).catch((error: unknown) => {
    notice.value = error instanceof Error ? error.message : String(error);
  });
}

const toolbar = computed<{ title?: string; back: boolean }>(() => {
  switch (step.value) {
    case "network":
      return { title: "Select network", back: true };
    case "token":
      return { title: "Select token", back: true };
    case "cancel":
      return { back: true };
    case "journey":
      return { title: props.topUp ? "Status" : "Withdraw to crypto", back: true };
    default:
      return { title: "Withdraw to crypto", back: true };
  }
});

function onBack() {
  switch (step.value) {
    case "cancel":
      step.value = "journey";
      return;
    case "summary":
      step.value = "address";
      return;
    case "address":
      step.value = "token";
      return;
    case "token":
      step.value = "network";
      return;
    default:
      // Leaving the journey leaves the withdrawal running; the list keeps it.
      emit("back");
  }
}

function pickNetwork(picked: WithdrawNetwork) {
  network.value = picked;
  step.value = "token";
}

function pickToken(picked: WithdrawDestination) {
  destination.value = picked;
  step.value = "address";
}

/** Four decimals of the destination's native, the trailing zeros dropped. */
function formatNative(planck: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const whole = planck / unit;
  const fraction = ((planck % unit) * 10_000n) / unit;
  const digits = fraction.toString().padStart(4, "0").replace(/0+$/, "");
  return digits === "" ? whole.toString() : `${whole}.${digits}`;
}

async function onAddress(entered: string) {
  address.value = entered;
  startError.value = null;
  step.value = "summary";
  const picked = destination.value;
  const base = toCashBase(amount.value);
  expectedNative.value = null;
  if (picked === null || base === null) {
    receive.value = undefined;
    return;
  }
  receive.value = null;
  try {
    if (picked.rail === "direct") {
      // What the CASH sells for on Asset Hub's pool: the direct rail lands exactly that.
      const live = await import("~~/lib/withdraw-live");
      const planck = await live.quoteDirectReceive(base);
      if (step.value !== "summary") return;
      receive.value = `${formatNative(planck, 10)} ${picked.asset}`;
      return;
    }
    // A provider destination shows what its offer for this amount said would land, and the
    // channel is opened at confirm for the native that offer was quoted for.
    await offers.learn(base);
    if (step.value !== "summary") return;
    const offer = offers.offerFor(picked);
    if (offer.state !== "available" || offers.sellable === null) {
      receive.value = undefined;
      return;
    }
    expectedNative.value = offers.sellable;
    receive.value = offer.formatted;
  } catch (error: unknown) {
    console.warn("[withdraw] receive estimate unavailable:", error);
    receive.value = undefined;
  }
}

async function confirm() {
  const picked = destination.value;
  const base = toCashBase(amount.value);
  if (picked === null || base === null || starting.value) return;
  // Judged once more here: the offer may have changed since the pick, and the channel is opened
  // next. Under the minimum, or with the provider not answering, nothing is opened.
  const allowed = offers.rowFor(picked);
  if (!allowed.pickable) {
    startError.value = allowed.subtitle ?? "This destination cannot take the amount.";
    return;
  }
  starting.value = true;
  startError.value = null;
  try {
    const outcome = await withdrawal.start({
      destinationId: picked.id,
      amount: base,
      destination: { chain: picked.chainLabel, asset: picked.asset, address: address.value },
      landingHex: landingAccountHex(picked, address.value),
      rail: picked.rail,
      ...(expectedNative.value === null ? {} : { expectedNative: expectedNative.value }),
    });
    if (outcome.ref === null) {
      startError.value = outcome.reason;
      return;
    }
    // The record exists either way; a refused prompt shows on the journey with a retry.
    step.value = "journey";
  } catch (error: unknown) {
    startError.value = error instanceof Error ? error.message : String(error);
  } finally {
    starting.value = false;
  }
}

async function confirmCancel() {
  const current = record.value;
  if (current === null || busy.value) return;
  busy.value = true;
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
    step.value = "journey";
  } finally {
    busy.value = false;
  }
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

// A record that moves clears the line about the last action.
watch(
  () => record.value?.status.kind,
  () => {
    notice.value = null;
  },
);

onMounted(() => {
  const opened = props.topUp;
  if (!opened) return;
  const ref = withdrawalRequestRef(opened.id);
  if (ref !== null && requests.has(ref)) requests.setForeground(ref);
});
onUnmounted(() => {
  // The polls that follow the request on screen stop; the worker keeps the request itself.
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

    <div class="flex min-h-0 flex-1 flex-col px-6 pt-6">
      <WithdrawNetworkScreen v-if="step === 'network'" :amount="amountBase" @pick="pickNetwork" />
      <WithdrawTokenScreen
        v-else-if="step === 'token' && network"
        :network="network"
        @pick="pickToken"
      />
      <WithdrawAddressScreen
        v-else-if="step === 'address' && network && destination"
        :network="network"
        :destination="destination"
        :initial="address"
        @next="onAddress"
      />
      <WithdrawSummaryScreen
        v-else-if="step === 'summary' && destination"
        :amount="amount"
        :destination="destination"
        :address="address"
        :receive="receive"
        :starting="starting"
        :error="startError"
        @confirm="confirm"
      />
      <WithdrawCancelScreen
        v-else-if="step === 'cancel'"
        :cancelling="busy"
        @confirm="confirmCancel"
        @keep="step = 'journey'"
      />
      <WithdrawJourneyScreen
        v-else-if="step === 'journey' && record"
        :record="record"
        :notice="notice"
        :busy="busy"
        @cancel="step = 'cancel'"
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
      <div v-else-if="step === 'journey'" class="flex flex-col items-center gap-4 pt-16">
        <span
          class="inline-block size-8 animate-spin rounded-full border-[3px] border-stroke-primary border-t-fg-primary"
        />
        <p class="text-body-m text-fg-secondary">Opening your withdrawal…</p>
      </div>
    </div>
  </main>
</template>
