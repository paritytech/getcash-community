// Front-loaded host permissions. Every permission the top-up flow needs is requested once at
// launch: Network (Remote) for the Chainflip domains, ChainSubmit for the funding pipeline, and
// Balance through a one-shot purse read. Outside a host container this is a no-op.

import { isHosted } from "./host-account";
import { readPurseBalance } from "./coinage";

/** The two Chainflip hosts that serve quotes, floors and prices. */
const CHAINFLIP_DOMAINS = ["rpc.mainnet.chainflip.io", "chainflip-swap.chainflip.io"];

/** The fiat rail's domain, read from the build-time base URL. A relative base yields nothing. */
function meldDomains(): string[] {
  const base = import.meta.env.VITE_MELD_BASE_URL as string | undefined;
  if (!base) return [];
  try {
    return [new URL(base).hostname];
  } catch {
    return [];
  }
}

export async function frontloadHostPermissions(): Promise<void> {
  if (!isHosted()) return;
  const { requestPermission, getPaymentManager } = await import("@parity/product-sdk-host");

  // Network first: the amount screen's floor-learning fires as soon as this resolves.
  await requestPermission({
    tag: "Remote",
    value: { domains: [...CHAINFLIP_DOMAINS, ...meldDomains()] },
  }).catch((e) => console.warn("[host] network grant failed (continuing):", e));

  // These do not gate the first quote and queue behind the network dialog.
  void requestPermission({ tag: "ChainSubmit", value: undefined }).catch((e) =>
    console.warn("[host] chain-submit grant failed (continuing):", e),
  );

  void (async () => {
    try {
      const payments = await getPaymentManager();
      if (payments) await readPurseBalance(payments);
    } catch (e) {
      console.warn("[host] balance grant failed (continuing):", e);
    }
  })();
}
