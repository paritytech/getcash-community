import type { StorageAdapter } from "@getsome/core";

/** In-memory StorageAdapter for tests. Optionally seeded; supports the `subscribe` shim. */
export function createMemoryAdapter(seed?: Record<string, string>): StorageAdapter {
  const map = new Map<string, string>(Object.entries(seed ?? {}));
  const subs = new Map<string, Set<(value: string | null) => void>>();
  const emit = (key: string) => {
    const cur = map.has(key) ? (map.get(key) as string) : null;
    subs.get(key)?.forEach((cb) => cb(cur));
  };

  return {
    async read(key) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    async write(key, value) {
      map.set(key, value);
      emit(key);
    },
    async clear(key) {
      map.delete(key);
      emit(key);
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
