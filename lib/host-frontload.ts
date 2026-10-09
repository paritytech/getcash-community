// Front-loaded host permissions. Every permission the top-up flow needs is requested once at
// launch: Network (Remote) for the Chainflip domains, ChainSubmit for the funding pipeline, and
// Balance through a one-shot purse read. A card payment later asks for its provider's hosts through
// `requestRemoteAccess`. Outside a host container this is a no-op.

import { isHosted } from "./host-account";
import { readPurseBalance } from "./coinage";

/** The two Chainflip hosts that serve quotes, floors and prices. */
const CHAINFLIP_DOMAINS = ["rpc.mainnet.chainflip.io", "chainflip-swap.chainflip.io"];

/** The hostnames of the absolute URLs among `urls`. A relative or empty URL yields nothing. */
function hostnamesOf(urls: readonly (string | undefined)[]): string[] {
  return urls.flatMap((url) => {
    if (!url) return [];
    try {
      return [new URL(url).hostname];
    } catch {
      return [];
    }
  });
}

/** The fiat rail's domain, read from the build-time base URL. */
function meldDomains(): string[] {
  return hostnamesOf([import.meta.env.VITE_MELD_BASE_URL as string | undefined]);
}

/** Asks the host for Network (Remote) access to the launch domains plus the hosts of `urls`.
 *  Outside a host container this is a no-op. */
export async function requestRemoteAccess(urls: readonly string[] = []): Promise<void> {
  if (!isHosted()) return;
  const { requestPermission } = await import("@parity/product-sdk-host");
  // The launch domains ride along in case the host replaces an earlier grant rather than adding.
  const domains = [...new Set([...CHAINFLIP_DOMAINS, ...meldDomains(), ...hostnamesOf(urls)])];
  await requestPermission({ tag: "Remote", value: { domains } });
}

export async function frontloadHostPermissions(): Promise<void> {
  if (!isHosted()) return;
  const { requestPermission, getPaymentManager } = await import("@parity/product-sdk-host");

  // Network first: the amount screen's floor-learning fires as soon as this resolves.
  await requestRemoteAccess().catch((e) =>
    console.warn("[host] network grant failed (continuing):", e),
  );

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
