// The customer key and the headless client built on it: hosted, the key comes from the host's
// entropy under its own label; off-host, from a seed this browser keeps; and the build's adapter
// URL decides between the real client and the offline fake. Each test reloads the modules to
// clear the per-page caches.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blake2b } from "@noble/hashes/blake2.js";
import { deriveCustomerKey } from "@getsome/ephemeral";

const host = vi.hoisted(() => ({
  hosted: true,
  deriveEntropy: vi.fn(),
}));
vi.mock("../lib/host-account", () => ({ isHosted: () => host.hosted }));
vi.mock("@parity/product-sdk-host", () => ({
  deriveEntropy: host.deriveEntropy,
  getHostLocalStorage: vi.fn(),
  getPaymentManager: vi.fn(),
  requestPermission: vi.fn(),
  isInsideContainerSync: () => host.hosted,
}));

const LABEL = "onramp:meld:customer:1";
const DEV_KEY = "getsome:meld:customer:dev";
const BASE = "https://adapter.test";

/** The host's entropy stand-in: a fixed function of the key it is asked for. */
const fakeEntropy = (key: Uint8Array) => blake2b(key, { dkLen: 32 });

/** A Web Storage stand-in whose entries the test can read. */
function memoryStorage() {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
  };
}

function throwingStorage() {
  const denied = () => {
    throw new DOMException("denied", "SecurityError");
  };
  return { getItem: denied, setItem: denied };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.resetModules();
  host.hosted = true;
  host.deriveEntropy.mockReset();
  host.deriveEntropy.mockImplementation(async (key: Uint8Array) => ({
    ok: true,
    value: fakeEntropy(key),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("customerSigner hosted", () => {
  it("derives from the host's entropy under the customer label, the same key on every load", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const label = new TextEncoder().encode(LABEL);
    const expected = deriveCustomerKey(fakeEntropy(label)).publicKeyHex;

    const { customerSigner } = await import("../lib/meld-customer");
    const first = await customerSigner();
    expect(host.deriveEntropy).toHaveBeenCalledTimes(1);
    expect(host.deriveEntropy.mock.calls[0]?.[0]).toEqual(label);
    expect(first.publicKeyHex).toBe(expected);
    expect(await customerSigner()).toBe(first);
    expect(host.deriveEntropy).toHaveBeenCalledTimes(1);

    vi.resetModules();
    const reloaded = await import("../lib/meld-customer");
    expect((await reloaded.customerSigner()).publicKeyHex).toBe(expected);
    expect(storage.entries.size).toBe(0);
  });

  it("surfaces a host refusal, and derives again on the next call", async () => {
    host.deriveEntropy.mockResolvedValueOnce({ ok: false, error: new Error("not permitted") });
    const { customerSigner } = await import("../lib/meld-customer");
    await expect(customerSigner()).rejects.toThrow("not permitted");
    await expect(customerSigner()).resolves.toMatchObject({
      publicKeyHex: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    });
  });
});

describe("customerSigner off-host", () => {
  beforeEach(() => {
    host.hosted = false;
  });

  it("keeps a random seed in storage and signs with it after a reload", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);

    const { customerSigner } = await import("../lib/meld-customer");
    const first = await customerSigner();
    const stored = storage.entries.get(DEV_KEY);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(first.publicKeyHex).toBe(
      deriveCustomerKey(Uint8Array.from(Buffer.from(stored ?? "", "hex"))).publicKeyHex,
    );

    vi.resetModules();
    const reloaded = await import("../lib/meld-customer");
    expect((await reloaded.customerSigner()).publicKeyHex).toBe(first.publicKeyHex);
    expect(storage.entries.get(DEV_KEY)).toBe(stored);
    expect(host.deriveEntropy).not.toHaveBeenCalled();
  });

  it("replaces a stored value that is no seed", async () => {
    const storage = memoryStorage();
    storage.entries.set(DEV_KEY, "not-a-seed");
    vi.stubGlobal("localStorage", storage);

    const { customerSigner } = await import("../lib/meld-customer");
    await customerSigner();
    expect(storage.entries.get(DEV_KEY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("holds the seed in memory for the page when storage throws", async () => {
    vi.stubGlobal("localStorage", throwingStorage());

    const { customerSigner } = await import("../lib/meld-customer");
    const first = await customerSigner();
    expect(first.publicKeyHex).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await customerSigner()).toBe(first);
  });
});

describe("meldHeadlessClient", () => {
  it("is the offline fake when the build names no adapter", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { meldHeadlessClient } = await import("../lib/meld-headless");
    expect(await meldHeadlessClient().getCustomer()).toMatchObject({ kyc: "approved" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls the named adapter as the customer key, with one client per page", async () => {
    host.hosted = false;
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubEnv("VITE_MELD_BASE_URL", BASE);
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const answers = [
      json({ challenge: "AAECAwQF" }),
      json({ token: "customer-token", expiresAtMs: Date.now() + 600_000 }),
      json({ customer: null }),
      json({ customer: null }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return answers[calls.length - 1] ?? json({}, 500);
      }),
    );

    const { meldHeadlessClient } = await import("../lib/meld-headless");
    const { customerSigner } = await import("../lib/meld-customer");
    expect(meldHeadlessClient()).toBe(meldHeadlessClient());
    expect(await meldHeadlessClient().getCustomer()).toBeNull();
    expect(await meldHeadlessClient().getCustomer()).toBeNull();

    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/customer/challenge`,
      `${BASE}/customer/token`,
      `${BASE}/customer`,
      `${BASE}/customer`,
    ]);
    expect(new Headers(calls[0]?.init?.headers).get("x-dev-product-id")).toBe("getcash.dev");
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({
      publicKey: (await customerSigner()).publicKeyHex,
      challenge: "AAECAwQF",
    });
    expect(new Headers(calls[3]?.init?.headers).get("x-customer-token")).toBe("customer-token");
    expect(storage.entries.get(DEV_KEY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns what an injected factory makes, until it is cleared", async () => {
    const { createFakeMeldHeadlessClient } = await import("@getsome/meld");
    const { meldHeadlessClient, setMeldHeadlessClientFactory } =
      await import("../lib/meld-headless");
    const injected = createFakeMeldHeadlessClient({ kyc: "pending" });
    setMeldHeadlessClientFactory(() => injected);
    expect(meldHeadlessClient()).toBe(injected);
    setMeldHeadlessClientFactory(null);
    expect(meldHeadlessClient()).not.toBe(injected);
    expect(await meldHeadlessClient().getCustomer()).toMatchObject({ kyc: "approved" });
  });
});
