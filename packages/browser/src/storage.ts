// Dev StorageAdapter over the browser's localStorage. For the out-of-host dev bundle only.

import type { StorageAdapter } from "@getsome/core";

/** Structural mirror of the Web Storage API; injectable for tests. */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function createLocalStorageAdapter(
  prefix = "onramp:dev",
  storage?: WebStorageLike,
): StorageAdapter {
  const backing = storage ?? (globalThis as { localStorage?: WebStorageLike }).localStorage;
  if (!backing) {
    throw new Error(
      "localStorage is not available; createLocalStorageAdapter is for plain-browser dev only",
    );
  }
  const subs = new Map<string, Set<(value: string | null) => void>>();
  const full = (key: string) => `${prefix}:${key}`;
  const emit = (key: string, value: string | null) => {
    subs.get(key)?.forEach((cb) => cb(value));
  };

  return {
    async read(key) {
      return backing.getItem(full(key));
    },
    async write(key, value) {
      backing.setItem(full(key), value);
      emit(key, value);
    },
    async clear(key) {
      backing.removeItem(full(key));
      emit(key, null);
    },
    // Same-session bus only; cross-tab 'storage' events are out of scope for the dev bundle.
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
