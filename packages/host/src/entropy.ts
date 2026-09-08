// EntropyPort over the host's deriveEntropy. The host derives the seed per (user, product,
// label); the same label yields the same seed after a reload.

import type { EntropyPort } from "@getsome/core";

/**
 * Structural mirror of a neverthrow Result; host-api-wrapper's `ResultAsync` satisfies it.
 */
export interface ResultLike<T> {
  isErr(): boolean;
  readonly value?: T;
  readonly error?: unknown;
}

/** Mirrors host-api-wrapper's `deriveEntropy(key) => ResultAsync<Uint8Array(32)>`. */
export type DeriveEntropyLike = (key: Uint8Array) => PromiseLike<ResultLike<Uint8Array>>;

export function createHostEntropyPort(deriveEntropy: DeriveEntropyLike): EntropyPort {
  return {
    deterministic: true,
    async deriveSeed(label: Uint8Array): Promise<Uint8Array> {
      const result = await deriveEntropy(label);
      if (result.isErr()) {
        throw new Error(
          `deriveEntropy failed: ${result.error instanceof Error ? result.error.message : String(result.error)}`,
        );
      }
      const seed = result.value;
      if (!seed || seed.length !== 32) {
        // A wrong-length seed derives a different, unrecoverable account.
        throw new Error(`deriveEntropy returned ${seed?.length ?? 0} bytes, expected 32`);
      }
      return seed;
    },
  };
}
