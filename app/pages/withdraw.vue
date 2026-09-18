<script setup lang="ts">
// The withdrawal entry, at #/withdraw. The amount shell the top-up uses, with withdrawal wording
// and the purse balance on offer, over the withdrawal route registry: crypto opens its package,
// card and bank are not available yet. The pending and history screens list the withdrawals, and
// opening one lands on its journey inside the package.
import { computed, markRaw, onMounted, ref, shallowRef, type Component } from "vue";
import FundingSelectorScreen from "../components/funding/FundingSelectorScreen.vue";
import { usePurseBalance } from "../composables/usePurseBalance";
import { useRoutePackageLoader } from "../composables/useRoutePackageLoader";
import { useVisualViewportHeight } from "../composables/useVisualViewportHeight";
import { fundingSelectorConfig } from "../funding/config";
import type {
  FundingHistoryReturnScreen,
  FundingShellEntryScreen,
  FundingTopUpReturnTarget,
} from "../funding/navigation";
import {
  availableFundingRoutes,
  getcashWithdrawPackages,
  loadFundingTopUpPackage,
  uniqueFundingPackages,
} from "../funding/packages";
import type { FundingRoute, FundingSelection } from "../funding/selection";
import { projectFundingTopUps, type FundingTopUp } from "../funding/top-ups";
import { useRequestsStore } from "../stores/requests";
import { cashToAmountInput } from "../utils/cash";
import { WITHDRAWAL_LIST_WORDING, WITHDRAWAL_WORDING } from "../withdraw/rows";
import { frontloadHostPermissions } from "~~/lib/host-frontload";

useVisualViewportHeight();
const requests = useRequestsStore();

const routeLabel = (route: FundingRoute): string =>
  fundingSelectorConfig.routes.find(({ id }) => id === route)?.label ?? route;
const {
  selection,
  activePackage,
  loading,
  routeError,
  continueToPackage: loadPackage,
  switchRoute,
  cancelPendingLoad: cancelPackageLoad,
  returnToShell,
} = useRoutePackageLoader(getcashWithdrawPackages, routeLabel);
const availableRoutes = availableFundingRoutes(
  getcashWithdrawPackages,
  fundingSelectorConfig.routes.map(({ id }) => id),
);

// The pill offers the purse balance as an amount the keypad can take. A skeleton while the read is
// in flight, no pill where there is no purse.
const purse = usePurseBalance();
const available = computed<string | null | undefined>(() => {
  const balance = purse.balance.value;
  if (balance === undefined) return null;
  if (balance === null) return undefined;
  return cashToAmountInput(balance, fundingSelectorConfig.amount.decimals);
});

// One adapter per package with a list.
const adapters = uniqueFundingPackages(getcashWithdrawPackages).flatMap((routePackage) =>
  routePackage.topUps === undefined ? [] : [routePackage.topUps.useAdapter()],
);
const topUps = computed(() => adapters.flatMap((adapter) => adapter.topUps.value));
const sections = computed(() =>
  projectFundingTopUps(topUps.value, fundingSelectorConfig, WITHDRAWAL_WORDING),
);
const topUpsReady = computed(() => requests.hydrated || requests.hostReadDone);

const activeTopUpPackage = shallowRef<Component | null>(null);
const activeTopUpId = ref<string | null>(null);
const openingTopUpId = ref<string | null>(null);
const topUpError = ref<string | null>(null);
const shellEntry = ref<FundingShellEntryScreen>("auto");
const historyReturn = ref<FundingHistoryReturnScreen>("amount");
let loadEpoch = 0;

const activeTopUp = computed<FundingTopUp | null>(() =>
  activeTopUpId.value === null
    ? null
    : (topUps.value.find(({ id }) => id === activeTopUpId.value) ?? null),
);

async function continueToPackage(next: FundingSelection) {
  shellEntry.value = "amount";
  topUpError.value = null;
  await loadPackage(next);
}

/** Opens a withdrawal from the list on its journey, inside its package. */
async function openTopUp(topUp: FundingTopUp, target: FundingTopUpReturnTarget) {
  const epoch = ++loadEpoch;
  cancelPackageLoad();
  shellEntry.value = target.screen;
  if (target.screen === "history") historyReturn.value = target.historyReturn;
  topUpError.value = null;
  openingTopUpId.value = topUp.id;
  const result = await loadFundingTopUpPackage(getcashWithdrawPackages, topUp);
  if (epoch !== loadEpoch) return;
  openingTopUpId.value = null;
  if (result.kind === "loaded") {
    activeTopUpId.value = topUp.id;
    activeTopUpPackage.value = markRaw(result.component);
    return;
  }
  if (result.kind === "unavailable") {
    topUpError.value = `${routeLabel(topUp.route)} withdrawals aren't available in this build yet.`;
    return;
  }
  console.error(`[withdraw] could not load ${result.packageId} status:`, result.error);
  topUpError.value = `${routeLabel(topUp.route)} status couldn't be opened. Try again.`;
}

function cancelPendingLoad() {
  cancelPackageLoad();
  if (openingTopUpId.value !== null) loadEpoch += 1;
  openingTopUpId.value = null;
  topUpError.value = null;
}

function returnFromTopUp() {
  loadEpoch += 1;
  activeTopUpPackage.value = null;
  activeTopUpId.value = null;
  openingTopUpId.value = null;
  topUpError.value = null;
}

/** Back from a fresh withdrawal's package lands on the pending list, where it now shows. */
function returnFromPackage() {
  loadEpoch += 1;
  shellEntry.value = "pending";
  returnToShell();
}

/** Upper bound on the permission front-load at launch. */
const FRONTLOAD_TIMEOUT_MS = 20_000;

onMounted(async () => {
  // The worker submits on the user's behalf; the grant is asked for at launch, before anything
  // depends on it. Failure is logged and ignored.
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
    await Promise.all(adapters.map((adapter) => adapter.refresh()));
  } catch (error: unknown) {
    console.warn("[withdraw] could not refresh the withdrawals:", error);
  }
});
</script>

<template>
  <component
    :is="activeTopUpPackage"
    v-if="activeTopUpPackage && activeTopUp"
    :top-up="activeTopUp"
    @back="returnFromTopUp"
  />
  <component
    :is="activePackage"
    v-else-if="activePackage && selection"
    :selection="selection"
    @back="returnFromPackage"
    @switch-route="switchRoute"
  />
  <FundingSelectorScreen
    v-else-if="topUpsReady"
    title="Withdraw funds"
    cta="Continue"
    :available="available"
    :initial-selection="selection"
    :available-routes="availableRoutes"
    :initial-screen="shellEntry"
    :history-return="historyReturn"
    :error="routeError"
    :loading="loading"
    :top-ups="sections.inProgress"
    :past-top-ups="sections.past"
    :latest-top-up="sections.latestSettled"
    :opening-top-up-id="openingTopUpId"
    :top-up-error="topUpError"
    :wording="WITHDRAWAL_LIST_WORDING"
    @change="cancelPendingLoad"
    @continue="continueToPackage"
    @open-top-up="openTopUp"
  />
  <FundingSelectorScreen v-else skeleton />
</template>
