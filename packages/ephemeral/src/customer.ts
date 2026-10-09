// Customer key for the Meld adapter: a 32-byte seed in, an sr25519 public key and a raw-message
// signer out. Same account as deriveKeypair for the same seed.

import { entropyToMiniSecret } from "@polkadot-labs/hdkd-helpers";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey, secretFromSeed, sign } from "@scure/sr25519";

export interface CustomerKey {
  readonly publicKey: Uint8Array;
  /** Lowercase, 0x-prefixed. */
  readonly publicKeyHex: string;
  signRaw(message: Uint8Array): Uint8Array;
}

export function deriveCustomerKey(seed: Uint8Array): CustomerKey {
  if (seed.length !== 32) {
    throw new Error(`deriveCustomerKey: seed must be exactly 32 bytes, got ${seed.length}`);
  }
  const secretKey = secretFromSeed(entropyToMiniSecret(seed));
  const publicKey = getPublicKey(secretKey);
  return {
    publicKey,
    publicKeyHex: `0x${bytesToHex(publicKey)}`,
    // The adapter verifies the challenge bytes as sent, so no <Bytes> wrapper is applied.
    signRaw: (message) => sign(secretKey, message),
  };
}
