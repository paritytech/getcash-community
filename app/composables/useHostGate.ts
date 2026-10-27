// TEMPORARY: this host release's TrUAPI runtime cannot serve chain access to embedded Products —
// a real connection attempt hangs with nothing for the Product to catch. Remove this file and its
// one call site in app.vue once the host fixes it.
//
// Two checks, cheapest first. `isChainSupported` is a single request/response message over the
// already-live host bridge, not a chain connection, so a broken runtime fails it fast; a host that
// reports support without honouring it (observed on Android) is caught by the real connection
// attempt that follows. Production (mainnet) and builds outside a host container skip both.
import { ref } from "vue";
import { NETWORK } from "@getsome/core";
import { isHosted } from "~~/lib/host-account";
import { withTimeout } from "~~/lib/timeout";

const QUICK_CHECK_TIMEOUT_MS = 1_500;

export const hostGateApplies = (): boolean => NETWORK.testnet && isHosted();

async function chainsReportSupported(): Promise<boolean> {
  const [{ PEOPLE, ASSET_HUB }, { isChainSupported }] = await Promise.all([
    import("~~/lib/host-chain"),
    import("@parity/product-sdk-host"),
  ]);
  const [people, assetHub] = await Promise.all([
    isChainSupported(PEOPLE.genesisHash),
    isChainSupported(ASSET_HUB.genesisHash),
  ]);
  return people.ok && people.value && assetHub.ok && assetHub.value;
}

export function useHostGate() {
  const incompatible = ref(false);

  async function check(): Promise<void> {
    const quickOk = await withTimeout(
      chainsReportSupported(),
      QUICK_CHECK_TIMEOUT_MS,
      "truapi runtime check",
    ).catch(() => false);
    if (!quickOk) {
      incompatible.value = true;
      return;
    }
    const { checkHostChains } = await import("~~/lib/host-chain");
    const result = await checkHostChains();
    if (!result.ok) incompatible.value = true;
  }

  if (hostGateApplies()) void check();

  return { incompatible };
}
