// sr25519 ephemeral key derivation: 32 bytes of entropy in, keypair out. No hex strings
// and no storage here, the caller owns where the entropy comes from.

import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { entropyToMiniSecret } from "@polkadot-labs/hdkd-helpers";
import { getPublicKey, secretFromSeed } from "@scure/sr25519";
import { getPolkadotSigner } from "polkadot-api/signer";
import { AccountId, type PolkadotSigner } from "polkadot-api";
import type { EphemeralSigner, HandoffKey } from "@getsome/core";

/**
 * Polkadot and Asset Hub SS58 prefix. Chainflip rejects the generic prefix 42 for Asset Hub
 * destinations.
 */
export const ASSET_HUB_SS58_PREFIX = 0;

export interface EphemeralKeypair {
  address: string;
  publicKey: Uint8Array;
  signer: PolkadotSigner;
}

/** Derives the ephemeral sr25519 keypair from exactly 32 bytes of entropy. */
export function deriveKeypair(entropy: Uint8Array): EphemeralKeypair {
  if (entropy.length !== 32) {
    throw new Error(
      `deriveKeypair: entropy must be exactly 32 bytes, got ${entropy.length}. ` +
        "A wrong-length seed would derive a different (unrecoverable) account.",
    );
  }
  const miniSecret = entropyToMiniSecret(entropy);
  const derive = sr25519CreateDerive(miniSecret);
  const { publicKey, sign } = derive("");
  const address = AccountId(ASSET_HUB_SS58_PREFIX).dec(publicKey);
  const signer = getPolkadotSigner(publicKey, "Sr25519", sign);
  return { address, publicKey, signer };
}

/** Narrow the keypair to the core port shape handed to the library. */
export function toEphemeralSigner(kp: EphemeralKeypair): EphemeralSigner {
  return { address: kp.address, signer: kp.signer };
}

export interface EphemeralKeypairWithSecret extends EphemeralKeypair {
  /** 64-byte schnorrkel secret (scalar plus nonce) for handoff settlement. Never persisted. */
  secretKey: Uint8Array;
}

/**
 * deriveKeypair plus the 64-byte schnorrkel secret for the same account. Throws if the secret does
 * not control the derived public key.
 */
export function deriveKeypairWithSecret(entropy: Uint8Array): EphemeralKeypairWithSecret {
  const kp = deriveKeypair(entropy); // re-validates the 32-byte entropy contract
  const secretKey = secretFromSeed(entropyToMiniSecret(entropy));
  const pub = getPublicKey(secretKey);
  if (pub.length !== kp.publicKey.length || !pub.every((b, i) => b === kp.publicKey[i])) {
    throw new Error(
      "deriveKeypairWithSecret: exported secret does not control the derived account; refusing to hand it out",
    );
  }
  return { ...kp, secretKey };
}

/**
 * Converts an ed25519-expanded sr25519 secret (clamped scalar plus nonce) into schnorrkel's
 * canonical form (scalar divided by the cofactor plus nonce). The division is an exact 3-bit
 * right shift of the clamped scalar; both forms control the same account.
 */
export function toSchnorrkelSecret(expanded: Uint8Array): Uint8Array {
  if (expanded.length !== 64) {
    throw new Error(
      `toSchnorrkelSecret: expected a 64-byte expanded secret, got ${expanded.length}`,
    );
  }
  // A scalar with live low bits is not clamped and would lose them in the shift.
  if ((expanded[0]! & 0b0000_0111) !== 0) {
    throw new Error("toSchnorrkelSecret: scalar is not ed25519-clamped (low bits set)");
  }
  const out = new Uint8Array(expanded); // nonce half carries over verbatim
  for (let i = 0; i < 32; i++) {
    out[i] = (expanded[i]! >> 3) | (i + 1 < 32 ? (expanded[i + 1]! << 5) & 0xff : 0);
  }
  return out;
}

/** Narrows to the core handoff shape with the secret in schnorrkel canonical form. */
export function toHandoffKey(kp: EphemeralKeypairWithSecret): HandoffKey {
  return { address: kp.address, signer: kp.signer, secretKey: toSchnorrkelSecret(kp.secretKey) };
}
