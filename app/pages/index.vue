<script setup lang="ts">
import { computed, markRaw, onMounted, ref, shallowRef, type Component, type Ref } from "vue";
import FundingJourneyRoute from "../components/funding/FundingJourneyRoute.vue";
import FundingSelectorScreen from "../components/funding/FundingSelectorScreen.vue";
import { useVisualViewportHeight } from "../composables/useVisualViewportHeight";
import { fundingSelectorConfig } from "../funding/config";
import {
  availableFundingRoutes,
  getcashRoutePackages,
  loadFundingPackage,
  loadFundingTopUpPackage,
  uniqueFundingPackages,
} from "../funding/packages";
import { frontloadHostPermissions } from "~~/lib/host-frontload";
import type { FundingJourneyStatus } from "../funding/handoff";
import {
  resolveFundingTopUpDestination,
  type FundingHistoryReturnScreen,
  type FundingShellEntryScreen,
  type FundingTopUpReturnTarget,
} from "../funding/navigation";
import type { FundingRoute, FundingSelection } from "../funding/selection";
import type { FundingTopUpAdapter } from "../funding/top-up-adapter";
import { projectFundingTopUps, type FundingTopUp } from "../funding/top-ups";

useVisualViewportHeight();

const selection = ref<FundingSelection | null>(null);
const activePackage = shallowRef<Component | null>(null);
const activeTopUpPackage = shallowRef<Component | null>(null);
const activeTopUpId = ref<string | null>(null);
const loading = ref(false);
const routeError = ref<string | null>(null);
const openingTopUpId = ref<string | null>(null);
const topUpError = ref<string | null>(null);
const topUpsReady = ref(false);
// Launch lands on add-funds; history is behind the clock.
const shellEntry = ref<FundingShellEntryScreen>("auto");
const historyReturn = ref<FundingHistoryReturnScreen>("amount");
let loadEpoch = 0;

/** The journey screen, entered from a package handoff ("package") or from the top-ups list
 *  ("top-up"). Null while a package or the selector has the screen. */
const journey = ref<{ title: string; route: FundingRoute; origin: "package" | "top-up" } | null>(
  null,
);

// One adapter and one status composable per package, indexed by every route the package serves.
const adapterByPackage = new Map(
  uniqueFundingPackages(getcashRoutePackages).flatMap((routePackage) =>
    routePackage.topUps === undefined
      ? []
      : [[routePackage, routePackage.topUps.useAdapter()] as const],
  ),
);
const statusByPackage = new Map(
  uniqueFundingPackages(getcashRoutePackages).flatMap((routePackage) =>
    routePackage.journeyStatus === undefined
      ? []
      : [[routePackage, routePackage.journeyStatus()] as const],
  ),
);
const adapterByRoute = new Map<FundingRoute, FundingTopUpAdapter>();
const statusByRoute = new Map<FundingRoute, Readonly<Ref<FundingJourneyStatus | null>>>();
for (const [route, routePackage] of Object.entries(getcashRoutePackages)) {
  const adapter = adapterByPackage.get(routePackage);
  if (adapter) adapterByRoute.set(route as FundingRoute, adapter);
  const status = statusByPackage.get(routePackage);
  if (status) statusByRoute.set(route as FundingRoute, status);
}
const topUpAdapters = [...adapterByPackage.values()];
const topUps = computed(() => topUpAdapters.flatMap((adapter) => adapter.topUps.value));
const journeyStatus = computed<FundingJourneyStatus | null>(() =>
  journey.value === null ? null : (statusByRoute.get(journey.value.route)?.value ?? null),
);
const activeTopUp = computed<FundingTopUp | null>(() => {
  if (activeTopUpId.value === null) return null;
  return topUps.value.find(({ id }) => id === activeTopUpId.value) ?? null;
});
const topUpSections = computed(() => projectFundingTopUps(topUps.value, fundingSelectorConfig));
const availableRoutes = availableFundingRoutes(
  getcashRoutePackages,
  fundingSelectorConfig.routes.map(({ id }) => id),
);

function routeLabel(route: FundingRoute): string {
  return fundingSelectorConfig.routes.find(({ id }) => id === route)?.label ?? route;
}

async function continueToPackage(next: FundingSelection) {
  const epoch = ++loadEpoch;
  shellEntry.value = "amount";
  selection.value = next;
  loading.value = true;
  routeError.value = null;
  topUpError.value = null;

  const result = await loadFundingPackage(getcashRoutePackages, next);
  if (epoch !== loadEpoch) return;

  loading.value = false;
  if (result.kind === "loaded") {
    activePackage.value = markRaw(result.component);
    return;
  }
  if (result.kind === "unavailable") {
    routeError.value = `${routeLabel(next.route)} isn't available in this build yet.`;
    return;
  }

  console.error(`[funding] could not load ${result.packageId}:`, result.error);
  routeError.value = `${routeLabel(next.route)} couldn't be opened. Try again.`;
}

/** Reloads the shell on another route's package, carrying the current amount. */
function switchRoute(route: FundingRoute) {
  void continueToPackage({ amount: selection.value?.amount ?? "", route });
}

async function openTopUp(topUp: FundingTopUp, target: FundingTopUpReturnTarget) {
  const epoch = ++loadEpoch;
  shellEntry.value = target.screen;
  if (target.screen === "history") historyReturn.value = target.historyReturn;
  topUpError.value = null;

  // A top-up past its deposit stage opens the journey directly; one still waiting for the deposit
  // opens its package's screen.
  if (resolveFundingTopUpDestination(topUp.state) === "journey") {
    activeTopUpId.value = topUp.id;
    journey.value = { title: "Status", route: topUp.route, origin: "top-up" };
    return;
  }

  openingTopUpId.value = topUp.id;
  const result = await loadFundingTopUpPackage(getcashRoutePackages, topUp);
  if (epoch !== loadEpoch) return;

  openingTopUpId.value = null;
  if (result.kind === "loaded") {
    activeTopUpId.value = topUp.id;
    activeTopUpPackage.value = markRaw(result.component);
    return;
  }
  if (result.kind === "unavailable") {
    topUpError.value = `${routeLabel(topUp.route)} status isn't available in this build yet.`;
    return;
  }

  console.error(`[funding] could not load ${result.packageId} status:`, result.error);
  topUpError.value = `${routeLabel(topUp.route)} status couldn't be opened. Try again.`;
}

function cancelPendingLoad() {
  if (!loading.value && openingTopUpId.value === null) {
    routeError.value = null;
    topUpError.value = null;
    return;
  }
  loadEpoch += 1;
  loading.value = false;
  openingTopUpId.value = null;
  routeError.value = null;
  topUpError.value = null;
}

function returnToSelector(entry: FundingShellEntryScreen = "amount") {
  loadEpoch += 1;
  shellEntry.value = entry;
  activePackage.value = null;
  loading.value = false;
  routeError.value = null;
}

function returnFromTopUp() {
  loadEpoch += 1;
  activeTopUpPackage.value = null;
  activeTopUpId.value = null;
  openingTopUpId.value = null;
  topUpError.value = null;
}

/** Swaps the active package for the journey screen. The request, `selection` and `activeTopUpId`
 *  stay in place. */
function handOffToJourney() {
  if (journey.value !== null) return;
  const openedTopUp = activeTopUp.value;
  const chosen = selection.value;
  if (activeTopUpPackage.value !== null && openedTopUp !== null) {
    journey.value = { title: "Status", route: openedTopUp.route, origin: "top-up" };
  } else if (activePackage.value !== null && chosen !== null) {
    journey.value = { title: routeLabel(chosen.route), route: chosen.route, origin: "package" };
  } else {
    return;
  }
  unmountPackages();
}

function unmountPackages() {
  activeTopUpPackage.value = null;
  activePackage.value = null;
}

/** Back from the journey: a fresh purchase lands on the top-ups list; a top-up opened from the
 *  list returns to where it was opened. */
function leaveJourney() {
  const origin = journey.value?.origin;
  journey.value = null;
  if (origin === "top-up") returnFromTopUp();
  else returnToSelector("pending");
}

/** "Add funds again" from an expired journey: whatever its origin, a fresh purchase starts at
 *  the amount screen. */
function addFundsAgain() {
  journey.value = null;
  returnFromTopUp();
  returnToSelector("amount");
}

const openTopUpRequest = (topUp: FundingTopUp): Promise<boolean> =>
  adapterByRoute.get(topUp.route)?.open(topUp) ?? Promise.resolve(false);

/** Upper bound on the permission front-load at launch. */
const FRONTLOAD_TIMEOUT_MS = 20_000;

onMounted(async () => {
  // Asks for the flow's host permissions at launch, before the top-up refresh. Failure is logged
  // and ignored.
  try {
    await Promise.race([
      frontloadHostPermissions(),
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error("permission front-load timed out")),
          FRONTLOAD_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (error: unknown) {
    console.warn("[host] permission front-load failed (continuing):", error);
  }
  try {
    await Promise.all(topUpAdapters.map((adapter) => adapter.refresh()));
  } catch (error: unknown) {
    console.warn("[funding] could not refresh top-ups:", error);
  } finally {
    topUpsReady.value = true;
  }
});
</script>

<template>
  <FundingJourneyRoute
    v-if="journey"
    :title="journey.title"
    :top-up="activeTopUp"
    :open="journey.origin === 'top-up' ? openTopUpRequest : null"
    :status="journeyStatus"
    @back="leaveJourney"
    @again="addFundsAgain"
  />
  <component
    :is="activeTopUpPackage"
    v-else-if="activeTopUpPackage && activeTopUp"
    :top-up="activeTopUp"
    @back="returnFromTopUp"
    @handoff="handOffToJourney"
  />
  <component
    :is="activePackage"
    v-else-if="activePackage && selection"
    :selection="selection"
    @back="returnToSelector()"
    @handoff="handOffToJourney"
    @switch-route="switchRoute"
  />
  <FundingSelectorScreen
    v-else-if="topUpsReady"
    :initial-selection="selection"
    :available-routes="availableRoutes"
    :initial-screen="shellEntry"
    :history-return="historyReturn"
    :error="routeError"
    :loading="loading"
    :top-ups="topUpSections.inProgress"
    :past-top-ups="topUpSections.past"
    :latest-top-up="topUpSections.latestSettled"
    :opening-top-up-id="openingTopUpId"
    :top-up-error="topUpError"
    @change="cancelPendingLoad"
    @continue="continueToPackage"
    @open-top-up="openTopUp"
  />
  <!-- Launch load: the amount screen's chrome with skeletons over the data still being fetched. -->
  <FundingSelectorScreen v-else skeleton />
</template>
