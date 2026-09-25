// The stables a burner can be funded in, by their token-table symbol, and what every leg needs of
// them: the pallet-assets id their min_balance and holdings are read under, and the Location the
// PSM, the pools and ChargeAssetTxPayment key them by. The PSM tier and the stable pool tier both
// read from here.

import { TOKENS, type TokenSpec, type XcmLocation } from "@getsome/core";
import { paseo_next_v2 } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";

type AssetHubApi = TypedApi<typeof paseo_next_v2>;
/** `xcm::v5::Location` as the PSM calls, the PSM storage and the fee-asset option take it. */
export type Location = Parameters<AssetHubApi["tx"]["Psm"]["mint"]>[0]["internal_asset"];

/** A stable the burner can be funded in, by its token-table symbol. */
export type Stable = "USDT" | "USDC";

/** The stables with the pallet-assets id their `min_balance` and holdings are read under. */
export const STABLE_TOKENS: Record<Stable, TokenSpec & { assetHubId: number }> = {
  USDT: TOKENS.USDT,
  USDC: TOKENS.USDC,
};

export const isStable = (value: unknown): value is Stable =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(STABLE_TOKENS, value);

// The table's Location type admits a value-less `Here`, which papi's type spells
// `value: undefined`; the same plain data either way.
export const asLocation = (location: XcmLocation) => location as Location;

export const stableLocation = (stable: Stable): Location =>
  asLocation(STABLE_TOKENS[stable].location);

/** The signing options that charge the dispatch fee in the stable, the one asset the burner holds
 *  on both stable tiers. The same options price the fee. */
export function stableTxOptions(stable: Stable): { asset: Location } {
  return { asset: stableLocation(stable) };
}
