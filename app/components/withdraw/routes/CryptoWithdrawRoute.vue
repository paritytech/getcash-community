<script setup lang="ts">
// The crypto withdrawal package: token, address and summary, then the journey once the purse was
// asked. Opened from the list with `topUp`, it goes straight to the journey of that record. The
// record and the worker carry on when this screen is left.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { depositTokenOf, type ConversionRoute } from "@getsome/funding";
import { useDrillIn } from "../../../composables/useDrillIn";
import { useScreen } from "../../../composables/useScreen";
import { useStateDirector } from "../../../composables/useStateDirector";
import { psmReserved, useWithdrawalRequest } from "../../../composables/useWithdrawalRequest";
import type { FundingPackageEmits } from "../../../funding/handoff";
import type { FundingSelection } from "../../../funding/selection";
import type { FundingTopUp } from "../../../funding/top-ups";
import { CASH_DECIMALS } from "@getsome/people";
import { useRequestsStore } from "../../../stores/requests";
import { cashAmount, fmtCash, toCashBase } from "../../../utils/cash";
import { previewStage } from "../../../utils/dev-preview-stage";
import { isDemoBuild } from "../../../utils/demo";
import { requestRefKey, type RequestRef } from "../../../utils/request-index";
import {
  ASSET_HUB_NETWORK,
  formatLanding,
  landingAccountHex,
  type WithdrawDestination,
} from "../../../withdraw/destinations";
import { sameSale, type WithdrawFeeView } from "../../../withdraw/offers";
import { withdrawalRequestRef } from "../../../withdraw/rows";
import ScreenShell from "../../ui/ScreenShell.vue";
import WithdrawAddressScreen from "../WithdrawAddressScreen.vue";
import WithdrawCancelScreen from "../WithdrawCancelScreen.vue";
import WithdrawFeesScreen from "../WithdrawFeesScreen.vue";
import WithdrawJourneyScreen from "../WithdrawJourneyScreen.vue";
import WithdrawReturnFundsScreen from "../WithdrawReturnFundsScreen.vue";
import WithdrawSummaryScreen from "../WithdrawSummaryScreen.vue";
import WithdrawTokenScreen from "../WithdrawTokenScreen.vue";
import { devLog } from "~~/lib/log";
import { trackAction } from "~~/lib/telemetry";

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
useStateDirector();

type Step = "token" | "address" | "summary" | "fees" | "journey" | "cancel" | "return-funds";
const step = ref<Step>(props.topUp ? "journey" : "token");
useScreen(() => (step.value === "fees" ? "fees" : (`withdraw.${step.value}` as const)));
/** The fee breakdown and where it was opened from, so back returns there. */
const { from: feesFrom, open: openFees } = useDrillIn<"summary" | "journey">("summary", () => {
  step.value = "fees";
});
const destination = ref<WithdrawDestination | null>(null);
const address = ref("");
/** What arrives, formatted; null while quoting; undefined without a quote. */
const receive = ref<string | null | undefined>(undefined);
/** The quote's fee split behind the summary's caption; null when it brought none. */
const fees = ref<WithdrawFeeView | null>(null);
/** The sale on Asset Hub the estimate was made for, frozen into the hand-off at confirm; null
 *  until the quote decided it. */
const sale = ref<ConversionRoute | null>(null);
const starting = ref(false);
const startError = ref<string | null>(null);
const busy = ref(false);
const notice = ref<string | null>(null);
/** What the pool would land for a held withdrawal; null until quoted. */
const poolFigure = ref<string | null>(null);

const record = computed(() => requests.foregroundWithdrawal);
const amount = computed(() => props.selection?.amount ?? props.topUp?.amount ?? "");
/** A withdrawal opened from the list whose record the store no longer has. */
const unavailable = computed(() => {
  if (!props.topUp || record.value !== null) return false;
  const ref = withdrawalRequestRef(props.topUp.id);
  return ref === null || !requests.has(ref);
});

/** Demo Skip on the summary: a simulated journey plays conversion, sending and sent, without a
 *  purse or a provider — the walkthrough a plain browser can give. */
const canSkipSummary = computed(() => isDemoBuild() && step.value === "summary");

async function onSkipSummary() {
  const picked = destination.value;
  const over = {
    ...(amount.value === "" ? {} : { amountHuman: amount.value }),
    ...(picked === null || address.value === ""
      ? {}
      : { destination: { chain: picked.chainLabel, asset: picked.asset, address: address.value } }),
  };
  step.value = "journey";
  const preview = await import("../../../utils/dev-preview");
  void preview.simulateWithdrawalJourney(over);
}

const toolbar = computed<{ title?: string; back: boolean }>(() => {
  switch (step.value) {
    case "token":
      return { title: "Select token", back: true };
    case "fees":
      return { title: "Fees", back: true };
    case "cancel":
    case "return-funds":
      return { back: true };
    case "journey":
      return { title: props.topUp ? "Status" : "Send to crypto", back: true };
    default:
      return { title: "Send to crypto", back: true };
  }
});

function onBack() {
  switch (step.value) {
    case "cancel":
    case "return-funds":
      step.value = "journey";
      return;
    case "fees":
      step.value = feesFrom.value;
      return;
    case "summary":
      step.value = "address";
      return;
    case "address":
      step.value = "token";
      return;
    default:
      // Leaving the journey leaves the withdrawal running; the list keeps it.
      emit("back");
  }
}

function pickToken(picked: WithdrawDestination) {
  destination.value = picked;
  step.value = "address";
}

/** "$1 CASH ≈ 0.19 DOT": the gross rate the direct estimate implies, in the landing asset. */
function directRate(units: bigint, decimals: number, base: bigint, asset: string): string | null {
  const value = Number(units) / 10 ** decimals / (Number(base) / 10 ** CASH_DECIMALS);
  if (!Number.isFinite(value) || value <= 0) return null;
  return `${cashAmount("1")} ≈ ${value >= 0.01 ? value.toFixed(2) : value.toPrecision(2)} ${asset}`;
}

/** What the summary shows for a destination and keeps for confirm. */
interface Estimate {
  sale: ConversionRoute;
  /** Undefined when the sale stands but its figure could not be priced. */
  receive: string | undefined;
  fees: WithdrawFeeView | null;
}

/** The sale `picked` takes for `base` CASH, decided on the chain as it stands, and what it lands.
 *  Throws when the chain cannot be read. */
async function estimate(picked: WithdrawDestination, base: bigint): Promise<Estimate> {
  const live = await import("~~/lib/withdraw-live");
  // The PSM's room this app's own redeems have spoken for, against the stable the destination
  // lands; the native and dotUSD read no PSM.
  const reserved =
    picked.landing === "native" || picked.landing === "dotUSD"
      ? 0n
      : psmReserved(requests.openWithdrawals, picked.landing);
  const sale = await live.chooseWithdrawRoute(base, picked.landing, reserved);
  try {
    // What the sale lands on Asset Hub in the token's decimals. Its fees are taken in CASH before
    // the sale, so the drill-in shows them as CASH.
    const [units, feesCash] = await Promise.all([
      live.quoteDirectReceive(base, sale),
      live.directFeesCash(sale),
    ]);
    const landing = depositTokenOf(sale);
    const receive = `${formatLanding(units, landing.decimals)} ${picked.asset}`;
    return {
      sale,
      receive,
      fees: {
        rows: [{ label: "Network fee", value: cashAmount(fmtCash(feesCash)) }],
        receive,
        rate: directRate(units, landing.decimals, base, picked.asset),
      },
    };
  } catch (error: unknown) {
    // The sale stands on its own: an estimate that cannot be priced hides the figure, as it
    // always did, and does not hold the withdrawal back.
    devLog("withdraw", "receive estimate unavailable", error, "warn");
    return { sale, receive: undefined, fees: null };
  }
}

function showEstimate(estimated: Estimate) {
  sale.value = estimated.sale;
  receive.value = estimated.receive;
  fees.value = estimated.fees;
}

/** Whether the summary moved on from `picked`: the user went back, or picked another token. */
const leftSummary = (picked: WithdrawDestination) =>
  step.value !== "summary" || destination.value !== picked;

async function onAddress(entered: string) {
  address.value = entered;
  startError.value = null;
  step.value = "summary";
  const picked = destination.value;
  const base = toCashBase(amount.value);
  fees.value = null;
  sale.value = null;
  if (picked === null || base === null) {
    receive.value = undefined;
    return;
  }
  receive.value = null;
  try {
    const estimated = await estimate(picked, base);
    // A chain answer that lands after the user went back and picked another token is for nobody:
    // the summary must still show the destination this run was started for.
    if (leftSummary(picked)) return;
    showEstimate(estimated);
  } catch (error: unknown) {
    devLog("withdraw", "receive estimate unavailable", error, "warn");
    receive.value = undefined;
  }
}

async function confirm() {
  const picked = destination.value;
  const base = toCashBase(amount.value);
  if (picked === null || base === null || starting.value) return;
  trackAction("withdraw.confirm");
  const shown = sale.value;
  starting.value = true;
  startError.value = null;
  try {
    // The sale is frozen next, so it is decided again on the chain as it stands: the PSM may have
    // filled up since the summary. Nothing starts on a sale the summary did not show.
    const [fresh, landingHex] = await Promise.all([
      estimate(picked, base),
      landingAccountHex(address.value, async (h160) =>
        (await import("~~/lib/withdraw-live")).readH160Account(h160),
      ),
    ]);
    if (leftSummary(picked) || sale.value !== shown) return;
    if (shown === null || !sameSale(shown, fresh.sale)) {
      showEstimate(fresh);
      startError.value = "The estimate has changed. Review it and confirm again.";
      return;
    }
    const outcome = await withdrawal.start({
      destinationId: picked.id,
      amount: base,
      destination: { chain: picked.chainLabel, asset: picked.asset, address: address.value },
      landingHex,
      sale: shown,
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
  trackAction("withdraw.cancel");
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

/** One action on the journey's record at a time; `failed` is the line shown when it could not
 *  start. */
async function act(run: (ref: RequestRef) => Promise<boolean>, failed: string) {
  const current = record.value;
  if (current === null || busy.value) return;
  busy.value = true;
  notice.value = null;
  try {
    if (!(await run(current.ref))) notice.value = failed;
  } finally {
    busy.value = false;
  }
}

// counted inside act, past its guard, so a tap while one is running counts once
const retry = () =>
  act((ref) => {
    trackAction("withdraw.retry");
    return withdrawal.retry(ref);
  }, "The withdrawal could not be restarted. Try again in a moment.");

const switchToPool = () =>
  act(
    withdrawal.switchToPool,
    "The withdrawal could not be moved to the pool. Try again in a moment.",
  );

// A record that moves clears the line about the last action.
watch(
  () => record.value?.status.kind,
  () => {
    notice.value = null;
  },
);

/** The record on screen while the PSM will not redeem it, by key: the pool's figure is quoted
 *  once for it, not on every poll that rewrites the record. */
const heldKey = computed(() => {
  const current = record.value;
  const held = current?.status.kind === "failed" && current.failure?.kind === "held";
  return held ? requestRefKey(current.ref) : null;
});

watch(
  heldKey,
  (key) => {
    poolFigure.value = null;
    const held = record.value;
    if (key === null || held === null) return;
    void withdrawal
      .poolFigure(held.ref)
      .then((figure) => {
        // An answer that lands after the record moved on is for nobody.
        if (heldKey.value === key) poolFigure.value = figure;
      })
      .catch((error: unknown) => {
        devLog("withdraw", "pool estimate unavailable", error, "warn");
      });
  },
  { immediate: true },
);

// The preview deck drives the step through the stage; a production build never has one.
// Immediate: the deck may have staged this package before it mounted.
const previewSecret = ref<string | undefined>(undefined);
watch(
  previewStage,
  (stage) => {
    if (stage?.kind !== "withdraw-package" || (stage.route ?? "crypto") !== "crypto") return;
    // The fiat routes' own steps never reach this package.
    if (stage.step === "quote" || stage.step === "region") return;
    // The address step needs a destination; the section's frames show USDC.
    destination.value = ASSET_HUB_NETWORK.destinations.find((d) => d.asset === "USDC") ?? null;
    address.value = stage.address ?? "";
    receive.value = stage.receive;
    fees.value = stage.fees ?? null;
    previewSecret.value = stage.secret;
    step.value = stage.step;
  },
  { immediate: true },
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
  <ScreenShell :title="toolbar.title" :back="toolbar.back" @back="onBack">
    <template v-if="canSkipSummary" #trailing>
      <button
        type="button"
        class="rounded-medium px-4 py-3 text-label-l font-normal text-fg-primary transition-colors hover:bg-action-tertiary-hover"
        @click="onSkipSummary"
      >
        Skip
      </button>
    </template>

    <WithdrawTokenScreen v-if="step === 'token'" :network="ASSET_HUB_NETWORK" @pick="pickToken" />
    <!-- Keyed so a staged address replaces the screen's own typing state. -->
    <WithdrawAddressScreen
      v-else-if="step === 'address' && destination"
      :key="address"
      :network="ASSET_HUB_NETWORK"
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
      :fees="fees"
      :starting="starting"
      :error="startError"
      @confirm="confirm"
      @fees="openFees('summary')"
    />
    <WithdrawFeesScreen
      v-else-if="step === 'fees' && fees"
      :amount="amount"
      :fees="fees"
      @back="step = feesFrom"
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
      :fees-available="fees !== null"
      :pool-figure="poolFigure"
      @cancel="step = 'cancel'"
      @retry="retry"
      @pool="switchToPool"
      @return-funds="step = 'return-funds'"
      @fees="openFees('journey')"
      @close="emit('back')"
    />
    <WithdrawReturnFundsScreen
      v-else-if="step === 'return-funds' && record"
      :record="record"
      :preview-secret="previewSecret"
      @back="step = 'journey'"
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
  </ScreenShell>
</template>
