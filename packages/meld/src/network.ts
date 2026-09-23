/**
 * Which People network this page is running on.
 *
 * The adapter verifies a personhood proof against one People chain and refuses a redeem whose
 * declared network is not one it serves, so the browser has to name it. This module is where that
 * name comes from.
 *
 * It is derived from the hostname rather than baked in at build time, and that is forced by the
 * pipeline rather than preferred: `.github/workflows/deploy.yml` runs `build` once, uploads a
 * single `site` artifact, and the `deploy` matrix publishes that same artifact to every network.
 * An `import.meta.env` value would therefore be one value shared by every deployment -- correct
 * for at most one of them, and wrong in the way that is hardest to see, because the build that
 * produced it looked fine.
 *
 * The hostname is the only per-deployment signal a shared artifact actually carries. That would be
 * a weak thing to hang this on if the mapping were incidental, and it is not: `networks.json` in
 * paritytech/deploy_script gives every network a `tld`, and the deploy matrix builds each domain
 * from exactly that value. `getcash.paseo` is the paseo-next-v2 deployment because `paseo` is
 * paseo-next-v2's TLD, not because someone chose a matching string twice.
 */

/**
 * TLD to network id, from `networks.json` (`tld` -> the key above it).
 *
 * The network ids are what the adapter matches on, exactly and case-sensitively, against
 * `auth.personhood.networks[].id`. They are deliberately the `networks.json` keys and not the
 * deploy workflow's `env` values, which differ: the deploy matrix calls previewnet `preview`.
 * Translating here, once, is what stops that difference becoming a 401 nobody can explain.
 */
const NETWORK_BY_TLD: Readonly<Record<string, string>> = Object.freeze({
  testnet: "previewnet",
  paseo: "paseo-next-v2",
  dot: "polkadot-test",
});

/**
 * The network id for a hostname, or `undefined` when the hostname names none.
 *
 * `undefined` rather than a fallback. A guessed network is a proof verified against the wrong
 * chain's ring root, which the adapter refuses as `UnknownRing` -- a 401 that says the caller is
 * not a person, when what happened is that this page did not know where it was. Refusing to guess
 * keeps that distinguishable.
 */
export function networkForHostname(hostname: string): string | undefined {
  const tld = hostname.split(".").pop();
  return tld === undefined ? undefined : NETWORK_BY_TLD[tld];
}

/**
 * This page's network: `override` when it names one, otherwise `hostname`'s.
 *
 * Both are parameters with no defaults, and the package reads neither `location` nor
 * `import.meta.env` itself. That keeps this module pure and testable, and it keeps the package
 * free of DOM and bundler-client types it otherwise has no need of -- the app supplies its own
 * environment at the one call site that has it.
 *
 * `override` exists for the two cases a hostname cannot answer: `localhost` in development, and a
 * preview build served from an unrelated TLD. Checked first, so neither needs special hostname
 * handling and an operator who set it explicitly gets what they asked for.
 */
export function currentNetwork(hostname: string, override?: string): string | undefined {
  const named = override?.trim();
  if (named !== undefined && named !== "") return named;
  return networkForHostname(hostname);
}
