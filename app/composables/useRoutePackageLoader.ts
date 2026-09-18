// Loads the package behind a route selection and holds it as the active screen. An unavailable
// route or a failed load becomes a line the amount screen shows. A later selection or a return to
// the shell drops a load still in flight.

import { markRaw, ref, shallowRef, type Component } from "vue";
import { loadFundingPackage, type FundingRoutePackages } from "../funding/packages";
import type { FundingRoute, FundingSelection } from "../funding/selection";

export function useRoutePackageLoader(
  packages: FundingRoutePackages,
  routeLabel: (route: FundingRoute) => string,
) {
  const selection = ref<FundingSelection | null>(null);
  const activePackage = shallowRef<Component | null>(null);
  const loading = ref(false);
  const routeError = ref<string | null>(null);
  let epoch = 0;

  async function continueToPackage(next: FundingSelection): Promise<void> {
    const current = ++epoch;
    selection.value = next;
    loading.value = true;
    routeError.value = null;

    const result = await loadFundingPackage(packages, next);
    if (current !== epoch) return;

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

  /** Reloads on another route's package, keeping the amount. */
  function switchRoute(route: FundingRoute): void {
    void continueToPackage({ amount: selection.value?.amount ?? "", route });
  }

  /** The shell changed while a load was pending: the load is dropped and its error cleared. */
  function cancelPendingLoad(): void {
    if (loading.value) epoch += 1;
    loading.value = false;
    routeError.value = null;
  }

  /** Back to the shell: the package is unmounted and any pending load dropped. */
  function returnToShell(): void {
    epoch += 1;
    activePackage.value = null;
    loading.value = false;
    routeError.value = null;
  }

  return {
    selection,
    activePackage,
    loading,
    routeError,
    continueToPackage,
    switchRoute,
    cancelPendingLoad,
    returnToShell,
  };
}
