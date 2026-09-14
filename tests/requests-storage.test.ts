// The request record storage seam: three interchangeable implementations of one contract.

import { describe, expect, it } from "vitest";
import {
  createHostKeyedStorage,
  createMemoryKeyedStorage,
  createWebKeyedStorage,
  type HostStorageLike,
  type KeyedStorage,
  type WebStorageLike,
} from "../app/funding/requests/storage";

function fakeWebStorage(): WebStorageLike {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

/** The host SDK reads an absent key as "". */
function fakeHostStorage(): HostStorageLike {
  const entries = new Map<string, string>();
  return {
    readString: async (key) => entries.get(key) ?? "",
    writeString: async (key, value) => {
      entries.set(key, value);
    },
    clear: async (key) => {
      entries.delete(key);
    },
  };
}

describe("request record storage", () => {
  it("memory, web and host implementations agree on absent, write, clear", async () => {
    const implementations: [string, KeyedStorage][] = [
      ["memory", createMemoryKeyedStorage()],
      ["web", createWebKeyedStorage(fakeWebStorage())],
      ["host", createHostKeyedStorage(fakeHostStorage())],
    ];
    const key = "getsome:request:dot-assethub:1";
    for (const [name, storage] of implementations) {
      expect(await storage.read(key), name).toBeNull();
      await storage.write(key, '{"tradeN":1}');
      expect(await storage.read(key), name).toBe('{"tradeN":1}');
      await storage.clear(key);
      expect(await storage.read(key), name).toBeNull();
    }
  });

  it("host storage maps an empty string to null", async () => {
    const storage = createHostKeyedStorage({
      readString: async () => "",
      writeString: async () => {},
      clear: async () => {},
    });
    expect(await storage.read("getsome:requests")).toBeNull();
  });
});
