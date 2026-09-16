<script setup lang="ts">
// The withdrawal entry, at #/offramping. The amount shell the top-up uses, with withdrawal wording
// and the purse balance on offer, over the withdrawal route registry: crypto opens its package,
// card and bank are not available yet.
import { computed } from "vue";
import FundingSelectorScreen from "../components/funding/FundingSelectorScreen.vue";
import { usePurseBalance } from "../composables/usePurseBalance";
import { useRoutePackageLoader } from "../composables/useRoutePackageLoader";
import { useVisualViewportHeight } from "../composables/useVisualViewportHeight";
import { fundingSelectorConfig } from "../funding/config";
import { availableFundingRoutes, getcashWithdrawPackages } from "../funding/packages";
import type { FundingRoute } from "../funding/selection";
import { cashToAmountInput } from "../utils/cash";

useVisualViewportHeight();

const routeLabel = (route: FundingRoute): string =>
  fundingSelectorConfig.routes.find(({ id }) => id === route)?.label ?? route;
const {
  selection,
  activePackage,
  loading,
  routeError,
  continueToPackage,
  switchRoute,
  cancelPendingLoad,
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
</script>

<template>
  <component
    :is="activePackage"
    v-if="activePackage && selection"
    :selection="selection"
    @back="returnToShell()"
    @switch-route="switchRoute"
  />
  <FundingSelectorScreen
    v-else
    title="Withdraw funds"
    cta="Continue"
    :available="available"
    :initial-selection="selection"
    :available-routes="availableRoutes"
    :error="routeError"
    :loading="loading"
    @change="cancelPendingLoad"
    @continue="continueToPackage"
  />
</template>
