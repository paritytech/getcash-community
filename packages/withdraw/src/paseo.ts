// Chain facts for the withdrawal pipeline.

import { NETWORK, TOKENS } from "@getsome/core";
import { asLocation } from "@getsome/funding";
import { CASH_LOCATION } from "@getsome/people";

/** The account holding the CASH and native reserves of People's pool. Every pool pairs with the
 *  native, and the pallet derives this account from the pair; it is fixed for the chain. */
export const PASEO_PEOPLE_POOL_ACCOUNT = NETWORK.people.poolAccount;

/** The pool's LP fee, parts per million: 0.3 percent. */
export const PEOPLE_POOL_FEE_PPM = 3_000n;

/** The native as People keys it. */
export const PEOPLE_NATIVE = TOKENS.PAS.locationOnPeople;

/** Signing on People from a key that holds only CASH: the fee is charged in CASH, and People's
 *  extra signed extension is passed disabled, which papi's default signer does not do on its
 *  own. */
export const PEOPLE_TX_OPTIONS = {
  asset: CASH_LOCATION,
  customSignedExtensions: { VerifyMultiSignature: { value: { type: "Disabled" } } },
} as const;

/** Signing on Asset Hub from a key that holds only CASH: the fee is charged in CASH through its
 *  pool. The same options price the fee. */
export const ASSET_HUB_CASH_TX_OPTIONS = { asset: asLocation(TOKENS.CASH.location) };

/** Where the withdrawal reads both chains and runs its dry runs: the best head, as the top up
 *  does. Every step acts on what its own transactions did a block ago, and the finalized head
 *  lags it by 12 to 60 s. Only the mortality checks read finality, since only a finalized block
 *  can say an attempt will never land. */
export const AT_BEST = { at: "best" } as const;
