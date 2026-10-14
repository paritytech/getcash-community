import { afterEach, describe, expect, it, vi } from "vitest";

const { built } = vi.hoisted(() => ({ built: [] as unknown[] }));
vi.mock("@getsome/chainflip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@getsome/chainflip")>();
  return {
    ...actual,
    createSwapSdk: async (network: string, options?: unknown) => {
      built.push([network, options]);
      return {
        getQuoteV2: async () => ({ quotes: [] }),
        requestDepositAddressV2: async () => "opened",
        getStatusV2: async () => ({}),
        getSwapLimits: async () => ({ minimumSwapAmounts: {} }),
      };
    },
  };
});

/** The module as a build with this key would load it. */
async function backendWith(key: string) {
  vi.stubEnv("VITE_CHAINFLIP_BROKER_API_KEY", key);
  vi.resetModules();
  built.length = 0;
  return import("../lib/chainflip-backend");
}

describe("the Chainflip SDK the app builds", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("opens channels on the BaaS broker the API key names", async () => {
    const { mainnetSdk } = await backendWith(" abc123 ");
    const sdk = await mainnetSdk();
    expect(built).toEqual([
      ["mainnet", { brokerUrl: "https://chainflip-broker.io/rpc/abc123", brokerCommissionBps: 5 }],
    ]);
    await expect(sdk.requestDepositAddressV2({} as never)).resolves.toBe("opened");
  });

  it("tells the pickers and the host whether a broker is configured", async () => {
    expect((await backendWith("abc123")).brokerConfigured()).toBe(true);
    expect((await backendWith("")).brokerConfigured()).toBe(false);
    expect((await backendWith("   ")).brokerConfigured()).toBe(false);
  });

  it("without a key still quotes, and refuses a channel before asking the SDK", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { mainnetSdk } = await backendWith("");
      const sdk = await mainnetSdk();
      expect(built).toEqual([["mainnet", undefined]]);
      await expect(sdk.getQuoteV2({} as never)).resolves.toEqual({ quotes: [] });
      await expect(sdk.requestDepositAddressV2({} as never)).rejects.toThrow(
        "Chainflip channels are not available in this build",
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("VITE_CHAINFLIP_BROKER_API_KEY"));
    } finally {
      warn.mockRestore();
    }
  });
});
