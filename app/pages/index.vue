<script setup lang="ts">
import {
  computed,
  markRaw,
  nextTick,
  onMounted,
  ref,
  shallowRef,
  watch,
  type Component,
  type Ref,
} from "vue";
import FundingJourneyRoute from "../components/funding/FundingJourneyRoute.vue";
import FundingSelectorScreen from "../components/funding/FundingSelectorScreen.vue";
import { useRoutePackageLoader } from "../composables/useRoutePackageLoader";
import { useVisualViewportHeight } from "../composables/useVisualViewportHeight";
import { fundingSelectorConfig } from "../funding/config";
import {
  availableFundingRoutes,
  getcashRoutePackages,
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
import { useRequestsStore } from "../stores/requests";
import { isDemoBuild } from "../utils/demo";
import { applyCurrentScene, seedLaunchPreviewTopUps } from "../utils/dev-preview";
import { previewStage, type PreviewStage } from "../utils/dev-preview-stage";
import { launchPreviewTopUps, previewTopUpScene } from "../utils/dev-preview-top-ups";

useVisualViewportHeight();
const requests = useRequestsStore();

function routeLabel(route: FundingRoute): string {
  return fundingSelectorConfig.routes.find(({ id }) => id === route)?.label ?? route;
}

const {
  selection,
  activePackage,
  loading,
  routeError,
  continueToPackage: loadPackage,
  switchRoute,
  cancelPendingLoad: cancelPackageLoad,
  returnToShell,
} = useRoutePackageLoader(getcashRoutePackages, routeLabel);
const activeTopUpPackage = shallowRef<Component | null>(null);
const activeTopUpId = ref<string | null>(null);
const openingTopUpId = ref<string | null>(null);
const topUpError = ref<string | null>(null);
const previewSeeding = ref(false);
const topUpsReady = computed(
  () => !previewSeeding.value && (requests.hydrated || requests.hostReadDone),
);
// Launch lands on add-funds; history is behind the clock.
const shellEntry = ref<FundingShellEntryScreen>("auto");
const historyReturn = ref<FundingHistoryReturnScreen>("amount");
// Top-up status loads; the package loader keeps its own.
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
// A preview scene's canned cards stand in for the adapters' — null in every production build.
// A preview scene's own rows sit alongside the adapters', never instead of them: the top-ups it
// still has running are seeded as real records, so their cards are the adapters' own projections
// and opening one opens the request. Only the finished ones are the scene's to supply.
const topUps = computed(() => [
  ...(previewTopUpScene.value?.topUps ?? []),
  ...topUpAdapters.flatMap((adapter) => adapter.topUps.value),
]);

// Launch simulation. `?preview=top-ups` seeds a running top-up before the first render, so the
// shell takes the same path a returning buyer's would: auto entry, resolved against live content.
if (isDemoBuild() && typeof window !== "undefined") {
  const scene = new URLSearchParams(window.location.search).get("preview");
  if (scene === "top-ups") {
    // The placeholder holds until the running records are in: `resolveFundingShellScreen` reads
    // the list once, so it has to read it complete.
    previewSeeding.value = true;
    void seedLaunchPreviewTopUps().finally(() => {
      previewTopUpScene.value = launchPreviewTopUps();
      previewSeeding.value = false;
    });
  }
}
// A scene sets the entry screen the once; the shell's own navigation owns it from there.
watch(
  previewTopUpScene,
  (scene) => {
    if (scene === null) return;
    shellEntry.value = scene.entry ?? "pending";
    topUpError.value = scene.error ?? null;
  },
  { immediate: true },
);
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

async function continueToPackage(next: FundingSelection) {
  shellEntry.value = "amount";
  topUpError.value = null;
  await loadPackage(next);
}

async function openTopUp(topUp: FundingTopUp, target: FundingTopUpReturnTarget) {
  const epoch = ++loadEpoch;
  // A package still loading must not surface under the top-up once it arrives.
  cancelPackageLoad();
  shellEntry.value = target.screen;
  if (target.screen === "history") historyReturn.value = target.historyReturn;
  topUpError.value = null;

  // A top-up past its deposit stage opens the journey directly; one still waiting for the deposit
  // opens its package's screen.
  if (resolveFundingTopUpDestination(topUp.state) === "journey") {
    activeTopUpId.value = topUp.id;
    journey.value = { title: "Top-up", route: topUp.route, origin: "top-up" };
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
  cancelPackageLoad();
  if (openingTopUpId.value !== null) loadEpoch += 1;
  openingTopUpId.value = null;
  topUpError.value = null;
}

function returnToSelector(entry: FundingShellEntryScreen = "amount") {
  loadEpoch += 1;
  shellEntry.value = entry;
  returnToShell();
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
    journey.value = { title: "Top-up", route: openedTopUp.route, origin: "top-up" };
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

/**
 * "Start over" on a fiat top-up that ended: re-enter its own route's package with the same amount.
 *
 * The failed request is left exactly where it is — it happened, and the list keeps it. Mounting
 * the package quotes again and opens a NEW funding request, which is the only way back into the
 * provider's widget: the old request's pay page is dead and will not take a second payment.
 */
function startOverFromJourney() {
  const current = journey.value;
  if (current === null) return;
  // By origin: `selection` outlives the screen that set it, so preferring it would restart a
  // top-up opened off the list at whatever was typed last.
  const amount =
    (current.origin === "top-up" ? activeTopUp.value?.amount : selection.value?.amount) ?? "";
  journey.value = null;
  returnFromTopUp();
  void continueToPackage({ amount, route: current.route });
}

/**
 * Puts the shell where a preview scene's state can be read. A scene only writes the stores, and
 * each screen reads a different part of them, so cycling one that belongs to a package or the
 * journey while the list has the screen left the deck looking stuck. Returns whether anything
 * moved. Dev and demo builds only — `previewStage` is null in every other.
 */
async function stagePreview(stage: PreviewStage): Promise<boolean> {
  if (stage.kind === "shell") {
    if (journey.value === null && activePackage.value === null && activeTopUpPackage.value === null)
      return false;
    journey.value = null;
    returnFromTopUp();
    // The scene's own entry screen, already set from its cards.
    returnToSelector(shellEntry.value);
    return true;
  }
  if (stage.kind === "journey") {
    // A journey already on this top-up (or on none) stays: re-entering it would reset the session
    // the scene just wrote.
    const topUpId = stage.topUpId ?? null;
    if (journey.value?.route === stage.route && activeTopUpId.value === topUpId) return false;
    loadEpoch += 1;
    unmountPackages();
    openingTopUpId.value = null;
    activeTopUpId.value = topUpId;
    journey.value = {
      title: topUpId === null ? routeLabel(stage.route) : "Top-up",
      route: stage.route,
      origin: topUpId === null ? "package" : "top-up",
    };
    return true;
  }
  if (activePackage.value !== null && selection.value?.route === stage.route) return false;
  journey.value = null;
  activeTopUpId.value = null;
  activeTopUpPackage.value = null;
  await continueToPackage({
    amount: selection.value?.amount ?? fundingSelectorConfig.amount.initial,
    route: stage.route,
  });
  return true;
}

watch(previewStage, async (stage) => {
  if (stage === null || !(await stagePreview(stage))) return;
  // The container is up. Its own mount and teardown ran as it changed — a package starts its entry
  // flow over, a journey left behind resets the session — so the scene's state goes on top again.
  await nextTick();
  await applyCurrentScene();
});

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
    @start-over="startOverFromJourney"
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
  <!-- A list loading placeholder, from the preview deck. -->
  <FundingSelectorScreen
    v-else-if="previewTopUpScene?.skeleton"
    skeleton
    :skeleton-screen="previewTopUpScene.entry === 'history' ? 'history' : 'pending'"
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
