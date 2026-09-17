import { blake2b } from "@noble/hashes/blake2.js";

const HOST_ENTROPY_CONTEXT_LIMIT = 32;
const encoder = new TextEncoder();

export function withdrawEntropyContext(label: string): Uint8Array {
  const bytes = encoder.encode(label);
  return bytes.length <= HOST_ENTROPY_CONTEXT_LIMIT ? bytes : blake2b(bytes, { dkLen: 32 });
}
