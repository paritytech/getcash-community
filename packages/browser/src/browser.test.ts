import { describe, expect, it } from "vitest";
import { createBrowserEntropyPort } from "./entropy";
import { createLocalStorageAdapter, type WebStorageLike } from "./storage";

function fakeWebStorage(): { backing: WebStorageLike; map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    backing: {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    },
  };
}

describe("createLocalStorageAdapter", () => {
  it("round-trips with the dev prefix and emits subscribe events", async () => {
    const { backing, map } = fakeWebStorage();
    const adapter = createLocalStorageAdapter("onramp:dev", backing);
    const seen: Array<string | null> = [];
    adapter.subscribe?.("k", (v) => seen.push(v));

    expect(await adapter.read("k")).toBeNull();
    await adapter.write("k", "v");
    expect(map.get("onramp:dev:k")).toBe("v");
    expect(await adapter.read("k")).toBe("v");
    await adapter.clear("k");
    expect(await adapter.read("k")).toBeNull();
    expect(seen).toEqual(["v", null]);
  });

  it("throws a clear error when no localStorage exists (host webviews)", () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).localStorage;
    try {
      expect(() => createLocalStorageAdapter()).toThrow(/dev only/);
    } finally {
      if (saved) Object.defineProperty(globalThis, "localStorage", saved);
    }
  });
});

describe("createBrowserEntropyPort", () => {
  it("is honest about non-determinism and caches per label within the session", async () => {
    const port = createBrowserEntropyPort();
    expect(port.deterministic).toBe(false);

    const label = new Uint8Array([1, 2, 3]);
    const a = await port.deriveSeed(label);
    const b = await port.deriveSeed(label);
    expect(a).toBe(b); // same session, same label -> same ephemeral
    expect(a.length).toBe(32);

    const other = await port.deriveSeed(new Uint8Array([9]));
    expect(other).not.toEqual(a);

    const fresh = createBrowserEntropyPort(); // "reload": a new port cannot reproduce the seed
    expect(await fresh.deriveSeed(label)).not.toEqual(a);
  });
});
