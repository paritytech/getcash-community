// The id a withdrawal's payment attempt is registered under, derived from the key so it can be
// known before the host is asked and derived again after any lost write.

import { blake2b } from "@noble/hashes/blake2.js";

const toHex = (bytes: Uint8Array): `0x${string}` =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.slice(2).match(/.{2}/g) ?? [], (byte) => parseInt(byte, 16));

/** The 32-byte id payment attempt `attempt` to the key is registered under, hex. The first
 *  attempt uses the key's public key itself; a later attempt, made after the host refused the
 *  previous one, needs an id the host has not seen, derived from the same key and the attempt
 *  number. The same derivation names the top-up claims. */
export function paymentIdFor(publicKeyHex: string, attempt: number): `0x${string}` {
  const publicKey = fromHex(publicKeyHex);
  if (attempt === 0) return toHex(publicKey);
  const input = new Uint8Array(publicKey.length + 4);
  input.set(publicKey);
  new DataView(input.buffer).setUint32(publicKey.length, attempt, true);
  return toHex(blake2b(input, { dkLen: 32 }));
}
