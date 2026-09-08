import type { EntropyPort, EphemeralSigner } from "@getsome/core";
import { deriveKeypair, toEphemeralSigner, type EphemeralKeypair } from "./derive";

export interface CreatedEphemeral {
  keypair: EphemeralKeypair;
  signer: EphemeralSigner;
}

/**
 * Derives the ephemeral account for `label` via the host's EntropyPort. The seed and keypair are
 * never persisted. Resume requires `entropy.deterministic === true`; otherwise the session maps
 * the flow to failed:stale.
 */
export async function createEphemeral(
  entropy: EntropyPort,
  label: Uint8Array,
): Promise<CreatedEphemeral> {
  const seed = await entropy.deriveSeed(label);
  const keypair = deriveKeypair(seed);
  return { keypair, signer: toEphemeralSigner(keypair) };
}
