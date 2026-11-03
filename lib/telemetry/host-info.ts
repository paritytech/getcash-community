/**
 * WHICH HOST, WHICH BUILD: the host's own report of itself, for telemetry.
 *
 * The host's `system.info()` returns `{ platform, name, version }` (the
 * host's native version string). It is the only way a product learns the
 * host app's version: the user agent names the WebView, not the app around
 * it. This app's truapi client has no system namespace, so it is asked
 * through host-api-wrapper, which the app already speaks. Null outside a
 * host, on an error, or after a second of silence (a host that does not
 * answer the call). Never throws.
 */
import { loadHost } from "./config";
import type { HostInfo } from "./device";
import { withTimeout } from "./util";

const TIMEOUT_MS = 1000;

export async function readHostInfo(): Promise<HostInfo | null> {
  try {
    const sdk = await loadHost();
    if (!sdk.isInsideContainerSync()) return null;
    const { hostSystem } = await import("@novasamatech/host-api-wrapper");
    const info = await withTimeout(hostSystem.info(), TIMEOUT_MS);
    if (!info) return null;
    return { name: String(info.name), version: info.version == null ? "" : String(info.version) };
  } catch {
    return null;
  }
}
