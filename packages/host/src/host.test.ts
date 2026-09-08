import { describe, expect, it } from "vitest";
import { createHostEntropyPort, type ResultLike } from "./entropy";
import { createHostStorageAdapter, type HostLocalStorageLike } from "./storage";

function fakeHostStorage(): { host: HostLocalStorageLike; map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    host: {
      async readString(key) {
        return map.get(key); // undefined when absent; the adapter must normalize to null
      },
      async writeString(key, value) {
        map.set(key, value);
      },
      async clear(key) {
        map.delete(key);
      },
    },
  };
}

const ok = <T>(value: T): PromiseLike<ResultLike<T>> =>
  Promise.resolve({ isErr: () => false, value });
const err = (error: unknown): PromiseLike<ResultLike<Uint8Array>> =>
  Promise.resolve({ isErr: () => true, error });

describe("createHostStorageAdapter", () => {
  it("round-trips through the prefixed host keys and normalizes absent to null", async () => {
    const { host, map } = fakeHostStorage();
    const adapter = createHostStorageAdapter(host, "onramp");

    expect(await adapter.read("k")).toBeNull();
    await adapter.write("k", "v");
    expect(map.get("onramp:k")).toBe("v"); // prefix applied at the host boundary
    expect(await adapter.read("k")).toBe("v");
    await adapter.clear("k");
    expect(await adapter.read("k")).toBeNull();
  });

  it("emits local subscribe events on write and clear (unprefixed keys)", async () => {
    const { host } = fakeHostStorage();
    const adapter = createHostStorageAdapter(host);
    const seen: Array<string | null> = [];
    const unsub = adapter.subscribe?.("k", (v) => seen.push(v));

    await adapter.write("k", "a");
    await adapter.clear("k");
    unsub?.();
    await adapter.write("k", "b"); // after unsubscribe; not seen
    expect(seen).toEqual(["a", null]);
  });

  it("propagates host transport failures as rejections", async () => {
    const adapter = createHostStorageAdapter({
      readString: async () => {
        throw new Error("bridge down");
      },
      writeString: async () => {},
      clear: async () => {},
    });
    await expect(adapter.read("k")).rejects.toThrow("bridge down");
  });
});

describe("createHostEntropyPort", () => {
  it("is deterministic and unwraps the host Result structurally", async () => {
    const seed = new Uint8Array(32).fill(7);
    const port = createHostEntropyPort(() => ok(seed));
    expect(port.deterministic).toBe(true);
    expect(await port.deriveSeed(new Uint8Array([1]))).toBe(seed);
  });

  it("throws loudly on host error and on wrong-length seeds", async () => {
    const errPort = createHostEntropyPort(() => err(new Error("no session")));
    await expect(errPort.deriveSeed(new Uint8Array([1]))).rejects.toThrow("no session");

    const shortPort = createHostEntropyPort(() => ok(new Uint8Array(31)));
    await expect(shortPort.deriveSeed(new Uint8Array([1]))).rejects.toThrow("expected 32");
  });
});
