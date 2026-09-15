import { blake2b } from "@noble/hashes/blake2.js";

/**
 * The 32-byte id a claim attempt is registered under. The first attempt uses the burner's public
 * key itself; a later attempt, made after the host settled the previous one short, needs an id
 * the host has not seen, derived from the same key and the attempt number.
 */
export function topUpIdFor(publicKey, attempt) {
  if (attempt === 0) return publicKey;
  const input = new Uint8Array(publicKey.length + 4);
  input.set(publicKey);
  new DataView(input.buffer).setUint32(publicKey.length, attempt, true);
  return blake2b(input, { dkLen: 32 });
}
