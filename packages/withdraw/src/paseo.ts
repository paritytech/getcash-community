// Paseo-Next chain facts for the withdrawal pipeline.

import { TOKENS } from "@getsome/core";
import { CASH_LOCATION } from "@getsome/people";

/** The account holding the CASH and PAS reserves of People's pool. Every pool pairs with the
 *  native, and the pallet derives this account from the pair; it is fixed for the chain. */
export const PASEO_PEOPLE_POOL_ACCOUNT = "5Di1GihZ1G2dYzfD7gv2DLEzFvRMBLas3jXGLeicVCFFtr8B";

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
