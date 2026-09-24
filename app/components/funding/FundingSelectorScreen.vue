<script setup lang="ts">
import { computed, ref, watch, type Component } from "vue";
import FundingAmountScreen from "./FundingAmountScreen.vue";
import { fundingSelectorConfig, type FundingSelectorConfig } from "../../funding/config";
import {
  resolveFundingShellScreen,
  type FundingHistoryReturnScreen,
  type FundingShellEntryScreen,
  type FundingTopUpReturnTarget,
} from "../../funding/navigation";
import {
  createFundingSelection,
  isFundingRouteAvailable,
  type FundingRoute,
  type FundingSelection,
} from "../../funding/selection";
import { useStateDirector } from "../../composables/useStateDirector";
import {
  hasFundingPendingContent,
  TOP_UP_LIST_WORDING,
  type FundingListWording,
  type InProgressFundingTopUp,
  type PastFundingTopUp,
  type SettledFundingTopUp,
} from "../../funding/top-ups";

type OpenableFundingTopUp = InProgressFundingTopUp | PastFundingTopUp;

const props = withDefaults(
  defineProps<{
    /** Launch-load placeholder: renders the entry screen's chrome with skeleton shapes over the
     *  not-yet-loaded data instead of the interactive shell. */
    skeleton?: boolean;
    /** Which screen the placeholder draws. Pending is for a launch that already knows a top-up
     *  is running. */
    skeletonScreen?: "amount" | "pending" | "history";
    config?: FundingSelectorConfig;
    initialSelection?: FundingSelection | null;
    /** Routes this build can run; the rest render dimmed and cannot be picked. Defaults to
     *  every configured route. */
    availableRoutes?: readonly FundingRoute[] | null;
    error?: string | null;
    loading?: boolean;
    topUps?: readonly InProgressFundingTopUp[];
    pastTopUps?: readonly PastFundingTopUp[];
    latestTopUp?: SettledFundingTopUp | null;
    initialScreen?: FundingShellEntryScreen;
    historyReturn?: FundingHistoryReturnScreen;
    openingTopUpId?: string | null;
    topUpError?: string | null;
    /** Passed through to the amount screen; the top-up wording by default. */
    title?: string;
    cta?: string;
    /** Passed through to the amount screen: the balance its pill offers, null while loading,
     *  omitted for no pill. */
    available?: string | null;
    /** The list screens' words around the rows; the top-up's by default. */
    wording?: FundingListWording;
    /** The screen the shell opens on. Defaults to the top-up amount screen; the withdrawal page
     *  passes its own, which draws the same contract to the withdrawal frames. */
    amountScreen?: Component | null;
  }>(),
  {
    skeleton: false,
    skeletonScreen: "amount",
    config: () => fundingSelectorConfig,
    initialSelection: null,
    availableRoutes: null,
    error: null,
    loading: false,
    topUps: () => [],
    pastTopUps: () => [],
    latestTopUp: null,
    initialScreen: "auto",
    historyReturn: "amount",
    openingTopUpId: null,
    topUpError: null,
    title: undefined,
    cta: undefined,
    available: undefined,
    wording: () => TOP_UP_LIST_WORDING,
    amountScreen: null,
  },
);

// The shell owns the preview deck while no package is open, so the top-ups scenes can be cycled
// from here.
useStateDirector();

const emit = defineEmits<{
  change: [];
  continue: [selection: FundingSelection];
  openTopUp: [topUp: OpenableFundingTopUp, target: FundingTopUpReturnTarget];
}>();

const amountScreen = computed<Component>(() => props.amountScreen ?? FundingAmountScreen);
const hasPendingContent = computed(() => hasFundingPendingContent(props.topUps, props.latestTopUp));
// The clock only opens a screen that has something on it: with nothing running and nothing
// finished, history is a dead end, so the control is not drawn at all.
const hasHistoryContent = computed(() => props.topUps.length > 0 || props.pastTopUps.length > 0);
/** A top-up still running; the only thing that may open the "Top-up in progress" screen. */
const hasTopUpInProgress = computed(() => props.topUps.length > 0);
const entryScreen = () => resolveFundingShellScreen(props.initialScreen, hasTopUpInProgress.value);
const screen = ref(entryScreen());
const historyReturnScreen = ref<FundingHistoryReturnScreen>(props.historyReturn);
const isRouteAvailable = (candidate: FundingRoute) =>
  isFundingRouteAvailable(candidate, props.availableRoutes);
const amount = ref(props.initialSelection?.amount ?? props.config.amount.initial);
// A buyer returning from a package keeps their route; a fresh entry starts on the configured
// default. Either one starts unpicked when this build cannot run it.
const initialRoute = props.initialSelection?.route ?? props.config.defaultRoute;
const route = ref<FundingRoute | null>(isRouteAvailable(initialRoute) ? initialRoute : null);

function changeAmount(next: string) {
  amount.value = next;
  emit("change");
}

function changeRoute(next: FundingRoute) {
  if (!isRouteAvailable(next)) return;
  route.value = next;
  emit("change");
}

function showAmount() {
  screen.value = "amount";
  emit("change");
}

function showHistory() {
  if (screen.value === "pending" || screen.value === "amount") {
    historyReturnScreen.value = screen.value;
  }
  screen.value = "history";
  emit("change");
}

function closeHistory() {
  // The same entry rule the shell was opened under: the list the buyer came from may have emptied
  // while they were in history.
  screen.value = resolveFundingShellScreen(historyReturnScreen.value, hasTopUpInProgress.value);
  emit("change");
}

function continueToPackage() {
  if (route.value === null || !isRouteAvailable(route.value)) return;
  const selection = createFundingSelection(amount.value, route.value, props.config.amount);
  if (selection !== null) emit("continue", selection);
}

// Leaving is gated on the settled card too, not just on what is running: a top-up that lands
// while the buyer is watching it should leave its "Added to your balance" card up until they go,
// rather than throwing them to the amount screen at the moment it succeeds.
watch(hasPendingContent, (hasContent) => {
  if (screen.value === "pending" && !hasContent) showAmount();
});

// A fresh entry request from the host (a journey closing back to the list, a preview scene)
// re-resolves the screen; the shell does not own where it was sent.
watch(
  () => props.initialScreen,
  () => {
    screen.value = entryScreen();
  },
);
</script>

<template>
  <section class="funding-selector">
    <FundingPendingScreen
      v-if="skeleton && skeletonScreen === 'pending'"
      skeleton
      :config="config"
    />
    <FundingHistoryScreen
      v-else-if="skeleton && skeletonScreen === 'history'"
      skeleton
      :config="config"
      @back="closeHistory"
    />
    <component
      :is="amountScreen"
      v-else-if="skeleton"
      skeleton
      :config="config"
      amount=""
      :route="null"
      :history="false"
      :title="title"
      :cta="cta"
      :available="available"
    />
    <FundingPendingScreen
      v-else-if="screen === 'pending'"
      :config="config"
      :top-ups="topUps"
      :latest-top-up="latestTopUp"
      :opening-top-up-id="openingTopUpId"
      :error="topUpError"
      :wording="wording"
      @history="showHistory"
      @new-top-up="showAmount"
      @open="emit('openTopUp', $event, { screen: 'pending' })"
    />
    <FundingHistoryScreen
      v-else-if="screen === 'history'"
      :config="config"
      :in-progress="topUps"
      :past="pastTopUps"
      :opening-top-up-id="openingTopUpId"
      :error="topUpError"
      :empty-text="wording.emptyHistory"
      @back="closeHistory"
      @open="
        emit('openTopUp', $event, {
          screen: 'history',
          historyReturn: historyReturnScreen,
        })
      "
    />
    <component
      :is="amountScreen"
      v-else
      :config="config"
      :amount="amount"
      :route="route"
      :available-routes="availableRoutes ?? undefined"
      :history="hasHistoryContent"
      :error="error"
      :loading="loading"
      :title="title"
      :cta="cta"
      :available="available"
      @change="changeAmount"
      @route="changeRoute"
      @continue="continueToPackage"
      @history="showHistory"
    />

    <!-- state-director scene label (dev/demo keys only) -->
    <PreviewSceneLabel />
  </section>
</template>

<style scoped>
.funding-selector {
  position: fixed;
  top: var(--vvt, 0px);
  right: 0;
  left: 0;
  width: 100%;
  max-width: 24.125rem; /* 386px — the design frame's width (the sheet inside the 402 phone) */
  height: var(--vvh, 100dvh);
  margin: 0 auto;
  overflow: hidden;
  background: var(--bg-surface-main);
  color: var(--fg-primary);
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
}
</style>
