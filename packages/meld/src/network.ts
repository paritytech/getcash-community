/**
 * Which People network this page runs on, derived from the hostname: `deploy.yml` publishes one
 * build artifact to every network, so a build-time value can't distinguish them.
 */

/**
 * TLD -> network id, per paritytech/deploy_script `networks.json`. Ids are the `networks.json`
 * keys (matched exactly by the adapter), not the deploy matrix `env` names (e.g. `preview`).
 */
const NETWORK_BY_TLD: Readonly<Record<string, string>> = Object.freeze({
  testnet: "previewnet",
  paseo: "paseo-next-v2",
  dot: "polkadot-test",
});

/**
 * Network id for a hostname, or `undefined` if none. No fallback: a guessed network fails as an
 * opaque `UnknownRing` 401 on the adapter.
 */
export function networkForHostname(hostname: string): string | undefined {
  // Web host serves from a `.li` mirror; the network is the label before it.
  const canonical = hostname.endsWith(".li") ? hostname.slice(0, -3) : hostname;
  const tld = canonical.split(".").pop();
  return tld === undefined ? undefined : NETWORK_BY_TLD[tld];
}

/**
 * The hostname's network, else `override`. Hostname wins so a build-baked override cannot mislabel
 * a real deployment; the override only names a host that names no network (localhost).
 */
export function currentNetwork(hostname: string, override?: string): string | undefined {
  const fromHost = networkForHostname(hostname);
  if (fromHost !== undefined) return fromHost;
  const named = override?.trim();
  return named ? named : undefined;
}
