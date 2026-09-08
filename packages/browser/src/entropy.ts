// Dev EntropyPort: random seeds held in memory only, never persisted. deterministic is false; a
// reload cannot re-derive the ephemeral and resume maps to failed:stale.

import type { EntropyPort } from "@getsome/core";

function labelKey(label: Uint8Array): string {
  let out = "";
  for (const b of label) out += b.toString(16).padStart(2, "0");
  return out;
}

export function createBrowserEntropyPort(): EntropyPort {
  // Same label, same seed within this session.
  const seeds = new Map<string, Uint8Array>();
  return {
    deterministic: false,
    async deriveSeed(label: Uint8Array): Promise<Uint8Array> {
      const key = labelKey(label);
      const cached = seeds.get(key);
      if (cached) return cached;
      const fresh = new Uint8Array(32); // filled before it widens through the Map (TS 5.9 ArrayBufferLike)
      globalThis.crypto.getRandomValues(fresh);
      seeds.set(key, fresh);
      return fresh;
    },
  };
}
