// The key of one request for the bridge routes: a 32-byte seed in, the key and its address out.
// The address is the same on Ethereum, on Base and on the Ethereum side of Hydration. The key
// signs the permit on Hydration. For now it also signs the transactions on Ethereum and on Base.
// TODO: once a forwarder and a relayer send those transactions, the key signs the permit only.
//
// It is not the refund key. The caller derives the seed with a label of its own, because the
// same seed gives the address of the Ethereum refund key, and a refund there would then look
// like a delivery.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export interface BridgeSigner {
  /** The address of the key, in lower case. */
  readonly address: string;
  /** The secp256k1 secret that signs. */
  readonly privateKey: Uint8Array;
}

/** The bridge key of the request that `seed` belongs to. The seed is the secret itself. */
export function deriveBridgeSigner(seed: Uint8Array): BridgeSigner {
  if (seed.length !== 32) {
    throw new Error(`deriveBridgeSigner: seed must be exactly 32 bytes, got ${seed.length}`);
  }
  if (!secp256k1.utils.isValidSecretKey(seed)) {
    throw new Error("deriveBridgeSigner: seed is not a valid secp256k1 secret key");
  }
  const publicKey = secp256k1.getPublicKey(seed, false);
  return {
    address: `0x${bytesToHex(keccak_256(publicKey.subarray(1)).subarray(12))}`,
    privateKey: Uint8Array.from(seed),
  };
}
