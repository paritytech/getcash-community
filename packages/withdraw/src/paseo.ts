// Chain facts for the withdrawal pipeline.

import { NETWORK, TOKENS } from "@getsome/core";
import { asLocation, PEOPLE_CASH_TX_OPTIONS } from "@getsome/funding";

/** The account holding the CASH and native reserves of People's pool. Every pool pairs with the
 *  native, and the pallet derives this account from the pair; it is fixed for the chain. */
export const PASEO_PEOPLE_POOL_ACCOUNT = NETWORK.people.poolAccount;

/** The pool's LP fee, parts per million: 0.3 percent. */
export const PEOPLE_POOL_FEE_PPM = 3_000n;

/** The native as People keys it. */
export const PEOPLE_NATIVE = TOKENS.PAS.locationOnPeople;

/** Signing on People from a key that holds only CASH, as the funding package's recovery signs. */
export const PEOPLE_TX_OPTIONS = PEOPLE_CASH_TX_OPTIONS;

/** Signing on Asset Hub from a key that holds only CASH: the fee is charged in CASH through its
 *  pool. The same options price the fee. */
export const ASSET_HUB_CASH_TX_OPTIONS = { asset: asLocation(TOKENS.CASH.location) };
