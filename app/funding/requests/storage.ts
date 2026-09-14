// The request records' storage seam: one keyed string store, read through `getRecordStorage`.
// The host's app-scoped storage when hosted; memory in the plain browser (development only, it
// persists nothing) and in tests. The Web Storage mirror exists only in the host too.

import type { HostLocalStorage } from "@parity/product-sdk-host";
import { isHosted } from "~~/lib/host-account";
import type { RequestRef } from "../../utils/request-index";

/** Storage key for the index of open request numbers. */
export const REQUEST_INDEX_KEY = "getsome:requests";
/** Storage key for the worker's funding jobs, keyed `${sourceId}:${tradeN}`. */
export const WORKER_JOBS_KEY = "getsome.funding.jobs";
/** Web Storage key for the boot mirror of the request map. */
export const MIRROR_KEY = "getsome:mirror:v2";
/** Storage key for the trade numbers whose burners were probed and found empty. */
export const PROBED_KEY = "getsome:probed";
/** A record's storage key. Source-qualified when the ref carries a source id, bare otherwise. */
export const requestKey = (ref: RequestRef) =>
  ref.sourceId ? `getsome:request:${ref.sourceId}:${ref.tradeN}` : `getsome:request:${ref.tradeN}`;

export interface KeyedStorage {
  /** The stored string, or null when the key is absent. */
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  clear(key: string): Promise<void>;
}

/** What the host implementation uses of the host SDK's key-value store. */
export type HostStorageLike = Pick<HostLocalStorage, "readString" | "writeString" | "clear">;

/** Structural mirror of the Web Storage API; injectable for tests. */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function createHostKeyedStorage(host: HostStorageLike): KeyedStorage {
  return {
    // The host SDK reads an absent key as ""; readers take null as "no record".
    read: async (key) => (await host.readString(key)) || null,
    write: (key, value) => host.writeString(key, value),
    clear: (key) => host.clear(key),
  };
}

export function createWebKeyedStorage(backing: WebStorageLike): KeyedStorage {
  return {
    read: async (key) => backing.getItem(key),
    write: async (key, value) => backing.setItem(key, value),
    clear: async (key) => backing.removeItem(key),
  };
}

export function createMemoryKeyedStorage(): KeyedStorage {
  const entries = new Map<string, string>();
  return {
    read: async (key) => entries.get(key) ?? null,
    write: async (key, value) => {
      entries.set(key, value);
    },
    clear: async (key) => {
      entries.delete(key);
    },
  };
}

/** The mirror's Web Storage: injected for tests, else the window's when hosted, else none.
 *  `undefined` until first resolved. */
let mirrorStorage: WebStorageLike | null | undefined;
let mirrorAvailable = true;

/** Makes the mirror live in `backing`; null keeps it off. Re-enables a mirror a throw disabled. */
export function setMirrorStorage(backing: WebStorageLike | null): void {
  mirrorStorage = backing;
  mirrorAvailable = true;
}

function mirrorBacking(): WebStorageLike | null {
  if (mirrorStorage !== undefined) return mirrorStorage;
  // Node defines a `localStorage` getter that warns when read; only a window has a usable one,
  // and a sandboxed window throws on access.
  if (typeof window === "undefined" || !isHosted()) return (mirrorStorage = null);
  try {
    mirrorStorage = window.localStorage ?? null;
  } catch {
    mirrorStorage = null;
  }
  return mirrorStorage;
}

/** A Web Storage call threw (quota, security error): the mirror is off for the session and the
 *  key is cleared best-effort so a later boot never reads a torn write. */
function disableMirror(backing: WebStorageLike): void {
  mirrorAvailable = false;
  try {
    backing.removeItem(MIRROR_KEY);
  } catch {
    // Nothing left to do: the backing is unusable.
  }
}

/** True while a mirror backing exists and no call to it has thrown this session. */
export const isMirrorAvailable = (): boolean => mirrorAvailable && mirrorBacking() !== null;

/** The mirror blob, or null when there is none or the read threw. */
export function readMirrorSync(): string | null {
  const backing = mirrorBacking();
  if (backing === null || !mirrorAvailable) return null;
  try {
    return backing.getItem(MIRROR_KEY);
  } catch {
    disableMirror(backing);
    return null;
  }
}

/** Writes the mirror blob; false when there is no mirror or the write threw. */
export function writeMirrorSync(value: string): boolean {
  const backing = mirrorBacking();
  if (backing === null || !mirrorAvailable) return false;
  try {
    backing.setItem(MIRROR_KEY, value);
    return true;
  } catch {
    disableMirror(backing);
    return false;
  }
}

export function clearMirrorSync(): void {
  const backing = mirrorBacking();
  if (backing === null) return;
  try {
    backing.removeItem(MIRROR_KEY);
  } catch {
    mirrorAvailable = false;
  }
}

let recordStorage: KeyedStorage | null = null;

/** Makes every record read and write go through `storage`. */
export function setRecordStorage(storage: KeyedStorage): void {
  recordStorage = storage;
}

/** The record storage: the injected one, else the host's when hosted, else memory. Resolved once
 *  and kept. */
export async function getRecordStorage(): Promise<KeyedStorage> {
  if (recordStorage) return recordStorage;
  if (isHosted()) {
    const { getHostLocalStorage } = await import("@parity/product-sdk-host");
    const host = await getHostLocalStorage();
    if (!host) throw new Error("host storage unavailable");
    recordStorage = createHostKeyedStorage(host);
  } else {
    recordStorage = createMemoryKeyedStorage();
  }
  return recordStorage;
}
