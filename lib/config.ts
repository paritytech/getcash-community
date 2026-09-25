import type { SourceId } from "@getsome/core";

// Chain and asset identifiers, as Chainflip and the icon set name them.
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

// The Chainflip source chains with their available assets. `native` is the network's own coin.
// The withdraw side and the floors read this catalog; the direct network below stays out of it.
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

/** The direct network: the buyer sends the token from any wallet to the request's own account
 *  on Asset Hub. The token picks the tier: DOT the pool, USDT the PSM with the pool through PAS
 *  as the fallback, USDC the pool through PAS. */
export const POLKADOT_CHAIN = {
  chain: CHAINS.Polkadot,
  native: ASSETS.DOT,
  assets: [ASSETS.DOT, ASSETS.USDT, ASSETS.USDC],
  label: "Polkadot",
} as const;

/** The on-ramp's networks in picker order: the direct one first, then the Chainflip ones. */
export const FUNDING_CHAINS = [POLKADOT_CHAIN, ...SOURCE_CHAINS] as const;
export type FundingChain = (typeof FUNDING_CHAINS)[number];

// The destination is always CASH; this app has no other destination assets.

/** Whether this build moves money through Chainflip. Off until the channel rail lands: the
 *  pickers keep listing the Chainflip routes, greyed and named as not yet available, so nothing
 *  can reach a deposit or a withdrawal that would have nowhere to go. */
export const CHAINFLIP_RAIL_ENABLED = false;

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

/** UI pair to direct SourceId, one id per token. The id keys the token's trade counter and
 *  burner labels. */
export const DIRECT_SOURCE_ID_BY_KEY = {
  "Polkadot:DOT": "dot-assethub",
  "Polkadot:USDT": "usdt-assethub",
  "Polkadot:USDC": "usdc-assethub",
} as const satisfies Record<string, SourceId>;
export type DirectSourceId = (typeof DIRECT_SOURCE_ID_BY_KEY)[keyof typeof DIRECT_SOURCE_ID_BY_KEY];
export const DIRECT_SOURCE_IDS: readonly DirectSourceId[] = Object.values(DIRECT_SOURCE_ID_BY_KEY);

export const isDirectSourceId = (sourceId: string | undefined): sourceId is DirectSourceId =>
  sourceId !== undefined && (DIRECT_SOURCE_IDS as readonly string[]).includes(sourceId);

/** What the buyer deposits for a direct source, as the route decision takes it. */
export type DepositAsset = "native" | "USDT" | "USDC";

export function depositAssetFor(sourceId: DirectSourceId): DepositAsset {
  switch (sourceId) {
    case "usdt-assethub":
      return "USDT";
    case "usdc-assethub":
      return "USDC";
    default:
      return "native";
  }
}

export function sourceIdFor(chain: string, asset: string): SourceId | undefined {
  const key = `${chain}:${asset}`;
  return (
    (DIRECT_SOURCE_ID_BY_KEY as Readonly<Record<string, SourceId>>)[key] ?? SOURCE_ID_BY_KEY[key]
  );
}

const PAIR_BY_SOURCE_ID: ReadonlyMap<string, { chain: string; asset: string }> = new Map(
  [...Object.entries(DIRECT_SOURCE_ID_BY_KEY), ...Object.entries(SOURCE_ID_BY_KEY)].map(
    ([key, sourceId]) => {
      const [chain, asset] = key.split(":") as [string, string];
      return [sourceId, { chain, asset }];
    },
  ),
);

/** The UI pair a source id names, in either catalog; undefined for a Meld or unknown id. */
export const sourcePairFor = (sourceId: string): { chain: string; asset: string } | undefined =>
  PAIR_BY_SOURCE_ID.get(sourceId);
