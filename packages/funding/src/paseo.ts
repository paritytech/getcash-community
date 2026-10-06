// Chain facts for the funding pipeline.

import { NETWORK, TOKENS } from "@getsome/core";

/** The coinage underlying on Asset Hub Next (on-chain symbol CASH), pallet-assets u32 id. */
export const PASEO_UNDERLYING_ASSET_ID = TOKENS.CASH.assetHubId;

/** People parachain id (ParachainInfo). */
export const PASEO_PEOPLE_PARA_ID = NETWORK.people.paraId;

/** Asset Hub parachain id (ParachainInfo). */
export const PASEO_ASSET_HUB_PARA_ID = NETWORK.assetHub.paraId;
