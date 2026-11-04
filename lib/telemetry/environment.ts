/**
 * Where this page is served from, in Sentry's words. Pure: no Sentry, no
 * window; the callers read `location` and `navigator` and pass them in.
 *
 * THE ENVIRONMENT IS THE SERVED HOST NAME, not the name baked into the build:
 * one export can be served under more than one name (`getcash.paseo`, its
 * `app.` subname, the `.li` web gateway), and a promoted CID is never rebuilt.
 *
 * AN ORIGIN WE CANNOT NAME IS NEVER FILED AS THE PRODUCT. A build opened from
 * http://localhost (a dev server, even one Polkadot Desktop binds) is
 * environment `local`: it would otherwise land in the production numbers.
 * Any other unrecognised https or polkadot:// host is `unknown`, source
 * `host-unknown`, so a host that hides its name shows up as such.
 */
import { parseUserAgent } from "./device";

type HostKind = "android" | "ios" | "desktop" | "browser";

export interface Served {
  hostname: string;
  protocol: string;
}

/** the dotNS suffixes a served name ends in */
const DOTNS_SUFFIXES = [".paseo", ".testnet", ".dot"] as const;

type EnvSource = "host" | "host-unknown" | "local";

/** the schemes a real host serves the product over; anything else is a developer's copy */
const HOSTED_SCHEMES = new Set(["https:", "polkadot:"]);

export function environmentFor(served: Served): { environment: string; source: EnvSource } {
  let name = served.hostname.toLowerCase();
  // manifest products serve from their `app.` subname
  if (name.startsWith("app.")) name = name.slice(4);
  // the web gateway mirrors
  if (name.endsWith(".li")) name = name.slice(0, -3);
  // the web gateway serves an executable as `<name>.app.<tld>.li`
  for (const suffix of DOTNS_SUFFIXES)
    if (name.endsWith(`.app${suffix}`)) name = name.slice(0, -(suffix.length + 4)) + suffix;
  const known = DOTNS_SUFFIXES.some(
    (suffix) => name.endsWith(suffix) && name.length > suffix.length,
  );
  if (known) return { environment: name, source: "host" };
  if (!HOSTED_SCHEMES.has(served.protocol)) return { environment: "local", source: "local" };
  return { environment: "unknown", source: "host-unknown" };
}

/** `scheme://host`. Not `location.origin`, which reads "null" for polkadot:// */
export function pageOrigin(served: Served): string {
  return `${served.protocol}//${served.hostname}`;
}

/** The host from the user agent's OS (parseUserAgent holds the one iPad rule). */
export function detectHostKind(device: {
  userAgent: string;
  inContainer: boolean;
  maxTouchPoints: number;
}): HostKind {
  if (!device.inContainer) return "browser";
  const { os } = parseUserAgent(device.userAgent, device.maxTouchPoints);
  return os === "android" || os === "ios" ? os : "desktop";
}

/** The DSN's host: the one domain the host's Remote grant must cover. Null
 *  for an empty or malformed DSN, and such a build sends nothing. */
export function ingestHost(dsn: string | undefined): string | null {
  if (!dsn) return null;
  try {
    const url = new URL(dsn);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.username || !url.hostname) return null;
    return url.hostname;
  } catch {
    return null;
  }
}
