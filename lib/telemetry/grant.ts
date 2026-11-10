/**
 * TELEMETRY'S OWN HOST GRANT, AND THE GATE ON DELIVERY.
 *
 * A host checks every page request against the domains the product was
 * granted, and one it was not raises the host's own network prompt. So
 * Sentry's ingest host is asked for here, and inside a host nothing is sent
 * until the answer is yes: the queue starts gated (init.ts) and this opens it.
 * A no, or no answer, leaves it shut for the page, so the person is never
 * prompted by a send.
 *
 * It is asked in a Remote request of ITS OWN, never added to the app's list:
 * the host remembers a "no" per domain, and a "no" to Sentry inside the app's
 * bundle would cost the app its real hosts. Asked once per page, and the
 * answer is not stored: a refusal the host keeps is answered silently from
 * then on. Ask it only when no other host prompt can be open: after the app's
 * front-loaded prompts (network, chain submit, balance) have all answered
 * (lib/host-frontload.ts). The host shows one modal at a time and auto-denies
 * a request made beside one.
 */
import { devLog } from "../log";
import { telemetryLive } from "./boot";
import { loadHost, telemetryIngestHost } from "./config";
import { openDelivery } from "./init";
import { describeError } from "./scrub";

let asked: Promise<boolean> | null = null;

/** Ask the host for Sentry's ingest domain, once per page, and open delivery
 *  on a yes. Never throws, never blocks: callers do not await it, and it waits
 *  as long as the person takes. True outside a host. */
export function requestTelemetryGrant(): Promise<boolean> {
  asked ??= ask();
  return asked;
}

async function ask(): Promise<boolean> {
  const host = telemetryIngestHost();
  // no usable DSN, or Sentry did not start: nothing will be sent, so ask nothing
  if (!host || !telemetryLive()) return false;
  try {
    const sdk = await loadHost();
    if (!sdk.isInsideContainerSync()) return true;
    const result = await sdk.requestPermission({ tag: "Remote", value: { domains: [host] } });
    // a tagged Result is always truthy: branch on .ok
    const granted = result.ok && result.value !== false;
    devLog(
      "telemetry",
      `telemetry grant: ${granted ? "granted" : "refused, nothing is sent"}`,
      undefined,
      granted ? "info" : "warn",
    );
    if (granted) openDelivery();
    return granted;
  } catch (error) {
    devLog("telemetry", "telemetry grant failed", { detail: describeError(error) }, "warn");
    return false;
  }
}
