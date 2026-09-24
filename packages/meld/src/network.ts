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
  const tld = hostname.split(".").pop();
  return tld === undefined ? undefined : NETWORK_BY_TLD[tld];
}

/**
 * `override` if non-blank, else the hostname's network. Override covers hosts that name no
 * network (localhost, previews on other TLDs).
 */
export function currentNetwork(hostname: string, override?: string): string | undefined {
  const named = override?.trim();
  if (named !== undefined && named !== "") return named;
  return networkForHostname(hostname);
}
