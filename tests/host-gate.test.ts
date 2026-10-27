// Development builds open only once the host serves the chains; production and standalone builds
// open straight away.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  testnet: true,
  hosted: true,
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
vi.mock("../lib/host-chain", () => ({ checkHostChains: env.check }));

import { useHostGate } from "../app/composables/useHostGate";

describe("host gate", () => {
  beforeEach(() => {
    env.testnet = true;
    env.hosted = true;
    env.check.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    // onMounted outside a component only warns; the tests run the check themselves.
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens straight away on a production build", () => {
    env.testnet = false;
    expect(useHostGate().state.value).toEqual({ kind: "ready" });
  });

  it("opens straight away outside a host container", () => {
    env.hosted = false;
    expect(useHostGate().state.value).toEqual({ kind: "ready" });
  });

  it("blocks a hosted development build until the host serves the chains", async () => {
    env.check.mockResolvedValueOnce({
      ok: false,
      reason:
        "asset-hub chain: host did not provide access: host chain probe (asset-hub) timed out after 8s",
    });
    const gate = useHostGate();
    expect(gate.state.value).toEqual({ kind: "checking" });

    await gate.check();
    expect(gate.state.value).toEqual({
      kind: "unreachable",
      reason:
        "asset-hub chain: host did not provide access: host chain probe (asset-hub) timed out after 8s",
    });

    env.check.mockResolvedValueOnce({ ok: true });
    await gate.check();
    expect(gate.state.value).toEqual({ kind: "ready" });
  });
});
