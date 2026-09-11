<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { fundingSelectorConfig, type FundingSelectorConfig } from "../../funding/config";
import {
  resolveFundingShellScreen,
  type FundingHistoryReturnScreen,
  type FundingShellEntryScreen,
  type FundingTopUpReturnTarget,
} from "../../funding/navigation";
import {
  createFundingSelection,
  type FundingRoute,
  type FundingSelection,
} from "../../funding/selection";
import {
  hasFundingPendingContent,
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
  },
);

const emit = defineEmits<{
  change: [];
  continue: [selection: FundingSelection];
  openTopUp: [topUp: OpenableFundingTopUp, target: FundingTopUpReturnTarget];
}>();

const hasPendingContent = computed(() => hasFundingPendingContent(props.topUps, props.latestTopUp));
const entryScreen = () =>
  resolveFundingShellScreen(props.initialScreen, hasPendingContent.value, props.topUps.length > 0);
const screen = ref(entryScreen());
const historyReturnScreen = ref<FundingHistoryReturnScreen>(props.historyReturn);
const availableRouteIds = computed<readonly FundingRoute[]>(
  () => props.availableRoutes ?? props.config.routes.map(({ id }) => id),
);
const isRouteAvailable = (candidate: FundingRoute) => availableRouteIds.value.includes(candidate);
const amount = ref(props.initialSelection?.amount ?? props.config.amount.initial);
// A remembered route this build cannot run starts unpicked.
const initialRoute = props.initialSelection?.route ?? null;
const route = ref<FundingRoute | null>(
  initialRoute !== null && isRouteAvailable(initialRoute) ? initialRoute : null,
);

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
  screen.value =
    historyReturnScreen.value === "pending" && !hasPendingContent.value
      ? "amount"
      : historyReturnScreen.value;
  emit("change");
}

function continueToPackage() {
  if (route.value === null || !isRouteAvailable(route.value)) return;
  const selection = createFundingSelection(amount.value, route.value, props.config.amount);
  if (selection !== null) emit("continue", selection);
}

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
    <FundingAmountScreen
      v-else-if="skeleton"
      skeleton
      :config="config"
      amount=""
      :route="null"
      :history="false"
    />
    <FundingPendingScreen
      v-else-if="screen === 'pending'"
      :config="config"
      :top-ups="topUps"
      :latest-top-up="latestTopUp"
      :opening-top-up-id="openingTopUpId"
      :error="topUpError"
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
      @back="closeHistory"
      @open="
        emit('openTopUp', $event, {
          screen: 'history',
          historyReturn: historyReturnScreen,
        })
      "
    />
    <FundingAmountScreen
      v-else
      :config="config"
      :amount="amount"
      :route="route"
      :available-routes="availableRouteIds"
      :history="topUps.length > 0 || pastTopUps.length > 0"
      :error="error"
      :loading="loading"
      @change="changeAmount"
      @route="changeRoute"
      @continue="continueToPackage"
      @history="showHistory"
    />
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
