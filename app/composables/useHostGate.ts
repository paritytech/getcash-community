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

export const hostGateApplies = (): boolean => NETWORK.testnet && isHosted();

/** The host's own capability check: documented as a non-hanging, catchable call, not a chain
 *  connection, so it is trusted to settle on its own rather than raced against a timeout. */
async function chainsReportSupported(): Promise<boolean> {
  const [{ PEOPLE, ASSET_HUB }, { isChainSupported }] = await Promise.all([
    import("~~/lib/host-chain"),
    import("@parity/product-sdk-host"),
  ]);
  const [people, assetHub] = await Promise.all([
    isChainSupported(PEOPLE.genesisHash),
    isChainSupported(ASSET_HUB.genesisHash),
  ]);
  if (!people.ok || !people.value) {
    console.error(
      `[host] TrUAPI check failed: people chain ${people.ok ? "not supported" : people.error.message}`,
    );
  }
  if (!assetHub.ok || !assetHub.value) {
    console.error(
      `[host] TrUAPI check failed: asset-hub chain ${assetHub.ok ? "not supported" : assetHub.error.message}`,
    );
  }
  return people.ok && people.value && assetHub.ok && assetHub.value;
}

export function useHostGate() {
  const incompatible = ref(false);

  async function check(): Promise<void> {
    const quickOk = await chainsReportSupported().catch((e: unknown) => {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`[host] TrUAPI check failed: quick check threw: ${reason}`);
      return false;
    });
    if (!quickOk) {
      incompatible.value = true;
      return;
    }
    const { checkHostChains } = await import("~~/lib/host-chain");
    const result = await checkHostChains();
    if (!result.ok) {
      console.error(`[host] TrUAPI check failed: ${result.reason}`);
      incompatible.value = true;
    }
  }

  if (hostGateApplies()) void check();

  return { incompatible };
}
