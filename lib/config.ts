import { isMeldAssetId, type MeldAssetId, type SourceId, type TokenSpec } from "@getsome/core";
import {
  directAssetName,
  isManualSourceId,
  MANUAL_SOURCE_IDS,
  MANUAL_SOURCES,
  manualDepositOf,
  type DepositAsset,
  type ManualSourceId,
} from "@getsome/funding";
import { directSellTokenOf } from "@getsome/meld";
import { devLog } from "./log";

// Chain and asset identifiers, as the icon set names them.
export const CHAINS = {
  Polkadot: "Polkadot",
} as const;

export const ASSETS = {
  DOT: "DOT",
  DOTUSD: "dotUSD",
  USDT: "USDT",
  USDC: "USDC",
} as const;

/** The direct network: the buyer sends the token from any wallet to the request's own account
 *  on Asset Hub. The token picks the tier: DOT the pool, dotUSD sent as it is with no conversion,
 *  USDT the PSM with the pool through PAS as the fallback, USDC the pool through PAS. */
export const POLKADOT_CHAIN = {
  chain: CHAINS.Polkadot,
  native: ASSETS.DOT,
  assets: [ASSETS.DOT, ASSETS.DOTUSD, ASSETS.USDT, ASSETS.USDC],
  label: "Polkadot",
} as const;

/** The on-ramp's networks: the direct one alone. */
export const FUNDING_CHAINS = [POLKADOT_CHAIN] as const;
export type FundingChain = (typeof FUNDING_CHAINS)[number];

/** A network as the screens name it, from the name the records give it. */
export const chainLabel = (chain: string): string =>
  chain === POLKADOT_CHAIN.chain ? POLKADOT_CHAIN.label : chain;

// The destination is always CASH; this app has no other destination assets.

/** The direct sources, one per token, as the funding package defines them. */
export type DirectSourceId = ManualSourceId;
export const DIRECT_SOURCE_IDS: readonly DirectSourceId[] = MANUAL_SOURCE_IDS;
export const isDirectSourceId = isManualSourceId;

/** What the buyer deposits for a direct source, as the route decision takes it. */
export type { DepositAsset };
export const depositAssetFor = manualDepositOf;

/** UI pair to direct SourceId: each direct source under Polkadot, its token named as the rails
 *  name it. */
export const DIRECT_SOURCE_ID_BY_KEY: Readonly<Record<string, DirectSourceId>> = Object.fromEntries(
  MANUAL_SOURCE_IDS.map((sourceId) => [
    `${CHAINS.Polkadot}:${directAssetName(MANUAL_SOURCES[sourceId].token)}`,
    sourceId,
  ]),
);

/** A direct token by the name the deposit screen gives it ("DOT", "dotUSD", "USDT", "USDC"):
 *  the token itself and what the route decision calls a deposit of it. */
export function directTokenNamed(
  asset: string,
): { token: TokenSpec; deposit: DepositAsset } | undefined {
  const sourceId = DIRECT_SOURCE_ID_BY_KEY[`${CHAINS.Polkadot}:${asset}`];
  return sourceId === undefined
    ? undefined
    : { token: MANUAL_SOURCES[sourceId].token, deposit: manualDepositOf(sourceId) };
}

export function sourceIdFor(chain: string, asset: string): SourceId | undefined {
  return DIRECT_SOURCE_ID_BY_KEY[`${chain}:${asset}`];
}

const PAIR_BY_SOURCE_ID: ReadonlyMap<string, { chain: string; asset: string }> = new Map(
  Object.entries(DIRECT_SOURCE_ID_BY_KEY).map(([key, sourceId]) => {
    const [chain, asset] = key.split(":") as [string, string];
    return [sourceId, { chain, asset }];
  }),
);

/** The UI pair a direct source id names; undefined for a Meld or unknown id. */
export const sourcePairFor = (sourceId: string): { chain: string; asset: string } | undefined =>
  PAIR_BY_SOURCE_ID.get(sourceId);

/** The off-ramp lanes this build sells through, in preference order, by the app's name for each
 *  asset (`usdt@assethub`), never by Meld's code for it, which the adapter owns and Meld renames.
 *  Only the direct Asset Hub sales, by default USDT before DOT since the PSM redeems the CASH for
 *  USDT at a fixed rate where DOT takes the pool's price.
 *  VITE_OFFRAMP_LANES overrides the list, comma separated; an asset left out is not offered,
 *  whatever the adapter lists. An entry that is not an asset id, or names an asset no sale sells
 *  (`usdc@assethub`), is dropped with a warning. */
export const OFFRAMP_LANE_ORDER: readonly MeldAssetId[] = (() => {
  const raw = import.meta.env.VITE_OFFRAMP_LANES as string | undefined;
  const listed = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
  const assets = listed.filter(isMeldAssetId);
  const lanes = assets.filter((asset) => directSellTokenOf(asset) !== undefined);
  const ignored = (entries: readonly string[], why: string): void => {
    if (entries.length === 0) return;
    devLog(
      "config",
      `VITE_OFFRAMP_LANES names ${entries.join(", ")}, ${why}; ignored`,
      undefined,
      "warn",
    );
  };
  ignored(
    listed.filter((entry) => !isMeldAssetId(entry)),
    "which are not asset ids (e.g. usdt@assethub)",
  );
  ignored(
    assets.filter((asset) => !lanes.includes(asset)),
    "which a sale cannot sell",
  );
  return lanes.length > 0 ? lanes : ["usdt@assethub", "dot@assethub"];
})();
