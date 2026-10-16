// Polls the adapter for an offramp sale's on-chain SaleVault state while its screen is open, and
// drives the return of a held one. Only a sale that routes through the vault has anything to read.
import { onUnmounted, ref, shallowRef, watch } from "vue";
import {
  fetchSaleVaultStatus,
  requestSaleVaultReturn,
  type SaleVaultStatus,
} from "~~/lib/sale-vault";

const POLL_MS = 15_000;

/** Reads and returns the SaleVault state for a funding request, re-reading while the screen lives. */
export function useSaleVaultStatus(fundingRequestId: () => string | undefined) {
  const status = shallowRef<SaleVaultStatus | null>(null);
  const returning = ref(false);
  const error = ref<string | null>(null);
  let clock: ReturnType<typeof setInterval> | null = null;

  async function refresh(): Promise<void> {
    const id = fundingRequestId();
    if (id === undefined) return;
    const next = await fetchSaleVaultStatus(id);
    if (next !== null) {
      status.value = next;
      // Nothing more changes once the provider was paid or the hold was fully returned: stop polling.
      if (
        next.status === "paid" ||
        next.status === "returned" ||
        next.returnStatus === "returned"
      ) {
        stop();
      }
    }
  }

  /** Asks the adapter to return a held sale to its home, folding the outcome into the view. */
  async function requestReturn(): Promise<void> {
    const id = fundingRequestId();
    if (id === undefined || returning.value) return;
    returning.value = true;
    error.value = null;
    const out = await requestSaleVaultReturn(id);
    returning.value = false;
    if (out.outcome === "returning") status.value = out.status;
    else if (out.outcome === "not-returnable") {
      // A 409 also lands when a return is already in flight (the sale is no longer Held). Re-read so
      // the view shows the in-flight return rather than telling the seller there is nothing to return.
      await refresh();
      error.value =
        status.value?.returnStatus === "returning" || status.value?.returnStatus === "returned"
          ? "A return is already in progress for this sale."
          : "There is nothing to return for this sale.";
    } else if (out.outcome === "not-found") error.value = "This sale could not be found.";
    else error.value = "The return could not be started. Try again.";
  }

  function stop(): void {
    if (clock !== null) {
      clearInterval(clock);
      clock = null;
    }
  }

  function start(): void {
    stop();
    void refresh();
    clock = setInterval(() => void refresh(), POLL_MS);
  }

  watch(fundingRequestId, (id) => (id === undefined ? stop() : start()), { immediate: true });
  onUnmounted(stop);

  return { status, returning, error, refresh, requestReturn };
}
