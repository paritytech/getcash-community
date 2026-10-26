// Development builds check the host before the app opens: inside a host container every chain read
// is the host's, and a host that does not answer leaves every screen to fail on its own. A testnet
// build that cannot reach both chains through the host shows one blocking screen instead.
// Production (mainnet) assumes the host works and opens straight away, as does a build outside a
// host container, which dials the chains itself.
import { onMounted, ref } from "vue";
import { NETWORK } from "@getsome/core";
import { isHosted } from "~~/lib/host-account";

export type HostGateState =
  { kind: "checking" } | { kind: "ready" } | { kind: "unreachable"; reason: string };

/** Whether this build checks the host at launch. */
export const hostGateApplies = (): boolean => NETWORK.testnet && isHosted();

export function useHostGate() {
  const state = ref<HostGateState>(hostGateApplies() ? { kind: "checking" } : { kind: "ready" });

  async function check(): Promise<void> {
    state.value = { kind: "checking" };
    const { checkHostChains } = await import("~~/lib/host-chain");
    const result = await checkHostChains();
    if (result.ok) {
      state.value = { kind: "ready" };
      return;
    }
    // The host logger renders an Error as `{}`; log the reason itself.
    console.error(`[host] launch check failed: ${result.reason}`);
    state.value = { kind: "unreachable", reason: result.reason };
  }

  onMounted(() => {
    if (state.value.kind === "checking") void check();
  });

  return { state, retry: check };
}
