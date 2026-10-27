// TEMPORARY: paired with useHostGate.ts. Delete together once the host fixes TrUAPI-runtime chain
// access for embedded Products.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  testnet: true,
  hosted: true,
  peopleOk: true,
  assetHubOk: true,
  check: vi.fn<() => Promise<{ ok: true } | { ok: false; reason: string }>>(),
}));

vi.mock("@getsome/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@getsome/core")>();
  return {
    ...original,
    NETWORK: new Proxy(original.NETWORK, {
      get: (target, key) => (key === "testnet" ? env.testnet : Reflect.get(target, key)),
    }),
  };
});
vi.mock("../lib/host-account", () => ({ isHosted: () => env.hosted }));
vi.mock("../lib/host-chain", () => ({
  PEOPLE: { label: "people", genesisHash: "0xpeople", wsUrl: "wss://people" },
  ASSET_HUB: { label: "asset-hub", genesisHash: "0xasset-hub", wsUrl: "wss://asset-hub" },
  checkHostChains: env.check,
}));
vi.mock("@parity/product-sdk-host", () => ({
  isChainSupported: (genesisHash: string) =>
    Promise.resolve({
      ok: true,
      value: genesisHash === "0xpeople" ? env.peopleOk : env.assetHubOk,
    }),
}));

import { useHostGate } from "../app/composables/useHostGate";

describe("host gate", () => {
  beforeEach(() => {
    env.testnet = true;
    env.hosted = true;
    env.peopleOk = true;
    env.assetHubOk = true;
    env.check.mockReset();
    env.check.mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never checks on a production build", async () => {
    env.testnet = false;
    const gate = useHostGate();
    await vi.waitFor(() => expect(env.check).not.toHaveBeenCalled());
    expect(gate.incompatible.value).toBe(false);
  });

  it("never checks outside a host container", async () => {
    env.hosted = false;
    const gate = useHostGate();
    await vi.waitFor(() => expect(env.check).not.toHaveBeenCalled());
    expect(gate.incompatible.value).toBe(false);
  });

  it("fails fast once the quick check reports the runtime unsupported, skipping the real connection", async () => {
    env.assetHubOk = false;
    const gate = useHostGate();
    await vi.waitFor(() => expect(gate.incompatible.value).toBe(true));
    expect(env.check).not.toHaveBeenCalled();
  });

  it("backstops a host that reports support without honouring it", async () => {
    env.check.mockResolvedValue({
      ok: false,
      reason: "people chain: host-routed connection failed",
    });
    const gate = useHostGate();
    await vi.waitFor(() => expect(gate.incompatible.value).toBe(true));
    expect(env.check).toHaveBeenCalledTimes(1);
  });

  it("stays compatible once both checks pass", async () => {
    const gate = useHostGate();
    await vi.waitFor(() => expect(env.check).toHaveBeenCalledTimes(1));
    expect(gate.incompatible.value).toBe(false);
  });
});
