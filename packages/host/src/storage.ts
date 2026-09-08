// StorageAdapter over the host's localStorage wrapper. The wrapper's surface is mirrored as
// minimal shapes and injected.

import type { StorageAdapter } from "@getsome/core";

/** Mirrors host-api-wrapper's `hostLocalStorage` (Promise-based, string helpers). */
export interface HostLocalStorageLike {
  readString(key: string): Promise<string | null | undefined>;
  writeString(key: string, value: string): Promise<void>;
  clear(key: string): Promise<void>;
}

/**
 * Wraps the host storage into core's StorageAdapter: prefixes the keys, normalizes absent to
 * null, and adds a same-session subscribe bus. Transport errors propagate as rejections.
 */
export function createHostStorageAdapter(
  host: HostLocalStorageLike,
  prefix = "onramp",
): StorageAdapter {
  const subs = new Map<string, Set<(value: string | null) => void>>();
  const full = (key: string) => `${prefix}:${key}`;
  const emit = (key: string, value: string | null) => {
    subs.get(key)?.forEach((cb) => cb(value));
  };

  return {
    async read(key) {
      return (await host.readString(full(key))) ?? null;
    },
    async write(key, value) {
      await host.writeString(full(key), value);
      emit(key, value);
    },
    async clear(key) {
      await host.clear(full(key));
      emit(key, null);
    },
    subscribe(key, cb) {
      let set = subs.get(key);
      if (!set) {
        set = new Set();
        subs.set(key, set);
      }
      set.add(cb);
      return () => {
        set.delete(cb);
      };
    },
  };
}
