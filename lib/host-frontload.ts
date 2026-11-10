// Front-loaded host permissions. Every permission the top-up flow needs is requested once at
// launch: Network (Remote) for the Chainflip domains, ChainSubmit for the funding pipeline, and
// Balance through a one-shot purse read. Outside a host container this is a no-op.

import { BAAS_BROKER_HOST, chainflipRpcUrl } from "@getsome/chainflip";
import { swapApiFor } from "@getsome/chainflip/swap-status";
import { brokerConfigured, NETWORK } from "./chainflip-backend";
import { SALE_SWAP_NETWORK } from "./config";
import { isHosted } from "./host-account";
import { readPurseBalance } from "./coinage";
import { describeError, reportFailure, requestTelemetryGrant } from "./telemetry";
import { appOpenHostPermissions, appOpenOutsideHost } from "./app-open";
import { devLog } from "./log";

/** Chainflip's swap API and state chain RPC on each network this build opens channels on. */
function chainflipDomains(): string[] {
  return [...new Set([NETWORK, SALE_SWAP_NETWORK])].flatMap((network) =>
    [swapApiFor(network), chainflipRpcUrl(network)].map((url) => new URL(url).hostname),
  );
}

/** The IP→country service the card and bank screens default the buyer's region from (lib/geo.ts).
 *  Only the grant is front-loaded: the lookup itself runs when one of those screens opens, so a
 *  user who never goes there never sends their address. */
const GEO_DOMAINS = ["get.geojs.io"];

/** The broker the channels open on, when the build has a key for it. */
function brokerDomains(): string[] {
  return brokerConfigured() ? [BAAS_BROKER_HOST] : [];
}

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

/** A refused network grant is reported once per page, though each page's mount asks. */
let refusalReported = false;

export async function frontloadHostPermissions(): Promise<void> {
  if (!isHosted()) {
    appOpenOutsideHost();
    return;
  }
  const { requestPermission, getPaymentManager } = await import("@parity/product-sdk-host");

  // Network first: the amount screen's floor-learning fires as soon as this resolves.
  await appOpenHostPermissions(() =>
    requestPermission({
      tag: "Remote",
      value: {
        domains: [...chainflipDomains(), ...brokerDomains(), ...GEO_DOMAINS, ...meldDomains()],
      },
    }).then(
      (result) => {
        if ((!result.ok || !result.value) && !refusalReported) {
          refusalReported = true;
          reportFailure("permission-refused", {
            reason: "network",
            context: { answer: result.ok ? "no" : describeError(result.error) },
          });
        }
      },
      (e) => devLog("host", "network grant failed (continuing)", e, "warn"),
    ),
  );

  // These do not gate the first quote and queue behind the network dialog.
  const chainSubmit = requestPermission({ tag: "ChainSubmit", value: undefined }).catch((e) =>
    devLog("host", "chain-submit grant failed (continuing)", e, "warn"),
  );

  const balance = (async () => {
    try {
      const payments = await getPaymentManager();
      if (payments) await readPurseBalance(payments);
    } catch (e) {
      devLog("host", "balance grant failed (continuing)", e, "warn");
    }
  })();

  // Telemetry's own domain, in a request of its own and only once every launch prompt has
  // answered: the host shows one modal at a time and refuses a request made beside one.
  void Promise.allSettled([chainSubmit, balance]).then(requestTelemetryGrant);
}
