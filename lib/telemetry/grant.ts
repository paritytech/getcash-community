/**
 * TELEMETRY'S OWN HOST GRANT: a warm-up, never a delivery gate.
 *
 * A host blocks page requests to domains the product was not granted, so
 * Sentry's ingest host has to be asked for. It is asked in a Remote request
 * of ITS OWN, never added to the app's list: the host remembers a "no" per
 * domain, and a "no" to Sentry inside the app's bundle would cost the app
 * its real hosts.
 *
 * Asked once per page, and the answer is not stored: an "Allow once" kept as
 * a permanent yes would be wrong on the next open, and a refusal the host
 * keeps is answered silently from then on. Whatever comes back (yes, no,
 * late, an error), delivery carries on through the retrying queue; nothing
 * waits on it. Ask it only when no other host prompt can be open: after the
 * app's front-loaded prompts (network, chain submit, balance) have all
 * answered (lib/host-frontload.ts). The host shows one modal at a time and
 * auto-denies a request made beside one.
 */
import { devLog } from "../log";
import { telemetryLive } from "./boot";
import { loadHost, telemetryIngestHost } from "./config";
import { describeError } from "./scrub";
import { withTimeout } from "./util";

/** a person reading a host modal; an Always grant answers at once */
const CONSENT_TIMEOUT_MS = 30_000;

let asked: Promise<boolean> | null = null;

/** Ask the host for Sentry's ingest domain, once per page. Never throws,
 *  never blocks: callers do not await it. True outside a host. */
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
    const result = await withTimeout(
      sdk.requestPermission({ tag: "Remote", value: { domains: [host] } }),
      CONSENT_TIMEOUT_MS,
    );
    if (!result) {
      devLog("telemetry", "telemetry grant: no answer", undefined, "warn");
      return false;
    }
    // a tagged Result is always truthy: branch on .ok
    const granted = result.ok && result.value !== false;
    devLog(
      "telemetry",
      `telemetry grant: ${granted ? "granted" : "refused"}`,
      undefined,
      granted ? "info" : "warn",
    );
    return granted;
  } catch (error) {
    devLog("telemetry", "telemetry grant failed", { detail: describeError(error) }, "warn");
    return false;
  }
}
