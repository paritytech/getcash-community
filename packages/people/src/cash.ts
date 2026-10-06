// The coinage underlying: asset 50000413 on Asset Hub, held on People as a foreign asset keyed by
// its reserve Location.

import { TOKENS } from "@getsome/core";

/** The opaque SettlementAsset foreign id the People port maps by default. */
export const CASH_FOREIGN_ID = "cash";

/** CASH has 6 decimals. */
export const CASH_DECIMALS = TOKENS.CASH.decimals;

/** The Assets-pallet key for CASH on People: its Asset Hub reserve Location. */
export const CASH_LOCATION = TOKENS.CASH.locationOnPeople;

/** The SettlementAsset a CASH handoff budget uses (pairs with createPeopleChainPort). */
export const CASH_SETTLEMENT = { kind: "foreign", id: CASH_FOREIGN_ID } as const;
