// Settle-back recipient resolution: the app hands the raw account publicKey here and gets the
// SS58 recipient back.

import { AccountId } from "polkadot-api";

/** Asset Hub / Polkadot SS58 prefix; Chainflip destAddress validation requires it. */
export const ASSET_HUB_SS58_PREFIX = 0;

/** Decode an account publicKey into the settle-back recipient SS58 (prefix 0 by default). */
export function recipientFromPublicKey(
  publicKey: Uint8Array,
  ss58Prefix: number = ASSET_HUB_SS58_PREFIX,
): string {
  if (publicKey.length !== 32) {
    throw new Error(`publicKey must be 32 bytes (AccountId32), got ${publicKey.length}`);
  }
  return AccountId(ss58Prefix).dec(publicKey);
}
