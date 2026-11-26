// The assets of NEAR Intents that the bridge routes use: the ETH it delivers to the key that
// sends the bridge transaction, and the sources a user can pay with.

import type { SourceId } from "@getsome/core";

/** The chain where a bridge route starts: Ethereum for Snowbridge, Base for the vault. */
export type BridgeStart = "ethereum" | "base";

/** ETH as NEAR Intents delivers it on each chain where a bridge route starts. */
export const INTENTS_ETH: Readonly<Record<BridgeStart, string>> = {
  ethereum: "nep141:eth.omft.near",
  base: "nep141:base.omft.near",
};

export interface IntentsSource {
  /** The asset as NEAR Intents names it. */
  asset: string;
  /** Set for a source on Ethereum: ETH itself, or a token. No source is on Base. */
  onEthereum?: "ether" | "token";
}

/** The crypto sources of getcash that NEAR Intents takes. FLIP is not one of them: NEAR Intents
 *  has no such asset. */
export const INTENTS_SOURCES: Readonly<Partial<Record<SourceId, IntentsSource>>> = {
  btc: { asset: "nep141:btc.omft.near" },
  eth: { asset: "nep141:eth.omft.near", onEthereum: "ether" },
  "usdc-eth": {
    asset: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    onEthereum: "token",
  },
  "usdt-eth": {
    asset: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near",
    onEthereum: "token",
  },
  "eth-arbitrum": { asset: "nep141:arb.omft.near" },
  "usdc-arbitrum": { asset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near" },
  "usdt-arbitrum": { asset: "nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near" },
  "bnb-bsc": { asset: "nep141:bnb.omdep.near" },
  "usdt-bsc": { asset: "nep141:bnb-0x55d398326f99059ff775485246999027b3197955.omdep.near" },
  "sol-solana": { asset: "nep141:sol.omft.near" },
  "usdc-solana": { asset: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near" },
  "usdt-solana": { asset: "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near" },
  "trx-tron": { asset: "nep141:tron.omft.near" },
  "usdt-tron": { asset: "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near" },
};

/** How a source reaches the key that sends the bridge transaction.
 *  - `direct`: the user sends ETH to the key.
 *  - `near`: the source is on another chain than the route's start, so NEAR Intents carries it.
 *  - `near-for-now`: the source is a token on the chain where the route starts. A key that holds
 *    only a token cannot pay gas, so NEAR Intents turns the token into ETH. This is only until a
 *    forwarder contract takes the token and a relayer pays its gas. */
export type SourceReach = "direct" | "near" | "near-for-now";

/** How `source` reaches the key for a route that starts on `start`. */
export function sourceReach(source: IntentsSource, start: BridgeStart): SourceReach {
  if (start !== "ethereum" || source.onEthereum === undefined) return "near";
  if (source.onEthereum === "ether") return "direct";
  // TODO: replace NEAR with the forwarder and the relayer for a token on Ethereum, and remove
  // `near-for-now`.
  return "near-for-now";
}
