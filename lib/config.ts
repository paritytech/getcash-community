import type { SourceId } from "@getsome/core";

// Chainflip chain/asset identifiers
export const CHAINS = {
  Bitcoin: "Bitcoin",
  Ethereum: "Ethereum",
  Solana: "Solana",
  Tron: "Tron",
  Polkadot: "Polkadot",
} as const;

export const ASSETS = {
  BTC: "BTC",
  ETH: "ETH",
  USDC: "USDC",
  USDT: "USDT",
  SOL: "SOL",
  TRX: "TRX",
  DOT: "DOT",
  CASH: "CASH",
} as const;

// Source chain configs with their available assets. `native` is the network's own coin.
export const SOURCE_CHAINS = [
  { chain: CHAINS.Bitcoin, native: ASSETS.BTC, assets: [ASSETS.BTC], label: "Bitcoin" },
  {
    chain: CHAINS.Ethereum,
    native: ASSETS.ETH,
    assets: [ASSETS.ETH, ASSETS.USDC, ASSETS.USDT],
    label: "Ethereum",
  },
  {
    chain: CHAINS.Solana,
    native: ASSETS.SOL,
    assets: [ASSETS.SOL, ASSETS.USDC, ASSETS.USDT],
    label: "Solana",
  },
  { chain: CHAINS.Tron, native: ASSETS.TRX, assets: [ASSETS.TRX, ASSETS.USDT], label: "Tron" },
] as const;

// The destination is always CASH; this app has no other destination assets.

/** UI pair to Chainflip SourceId, also the `?source=` deep-link vocabulary. A pair with no
 *  entry has no swap source. */
export const SOURCE_ID_BY_KEY: Readonly<Record<string, SourceId>> = {
  "Bitcoin:BTC": "btc",
  "Ethereum:ETH": "eth",
  "Ethereum:USDC": "usdc-eth",
  "Ethereum:USDT": "usdt-eth",
  "Solana:SOL": "sol-solana",
  "Solana:USDC": "usdc-solana",
  "Solana:USDT": "usdt-solana",
  "Tron:USDT": "usdt-tron",
  "Tron:TRX": "trx-tron",
};

export function sourceIdFor(chain: string, asset: string): SourceId | undefined {
  return SOURCE_ID_BY_KEY[`${chain}:${asset}`];
}
