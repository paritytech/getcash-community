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

  it("offers a sale's swap on mainnet only with a broker, so no seller does KYC for a refused channel", async () => {
    vi.doMock("@getsome/core", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@getsome/core")>();
      return { ...actual, NETWORK: { ...actual.NETWORK, testnet: false } };
    });
    try {
      expect((await backendWith("abc123")).saleChannelsOpen()).toBe(true);
      expect((await backendWith("")).saleChannelsOpen()).toBe(false);
    } finally {
      vi.doUnmock("@getsome/core");
    }
  });

  it("offers a sale's swap on Perseverance, which still takes the default broker", async () => {
    vi.doMock("@getsome/core", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@getsome/core")>();
      return { ...actual, NETWORK: { ...actual.NETWORK, testnet: true } };
    });
    try {
      expect((await backendWith("")).saleChannelsOpen()).toBe(true);
    } finally {
      vi.doUnmock("@getsome/core");
    }
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

describe("a top-up channel", () => {
  const BURNER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
  const BURNER_OTHER_PREFIX = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
  const REFUND = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
  const DEPOSIT = "bc1p9438v9cmxqsm0hrkfm27nq4k09w7s7lrnsay6tfc2x0hrttm56qs36t3z5";
  const SOURCE = { chain: "Bitcoin", asset: "BTC" };
  const EGRESS = { chain: "Assethub", asset: "USDT" };
  const SERVED = {
    depositAddress: DEPOSIT,
    destinationAddress: BURNER_OTHER_PREFIX,
    destinationChain: "Assethub",
    destinationAsset: "USDT",
    refundAddress: REFUND.toUpperCase(),
    sourceChain: "Bitcoin",
    sourceAsset: "BTC",
    commissionBps: 5,
    minPrice: 1990,
    expired: false,
  };
  const opened = {
    depositChannelId: "7-Bitcoin-1",
    deposit: { address: DEPOSIT, amount: 1n, formatted: "1", assetSymbol: "BTC", expiresAt: 0 },
  };
  const rail = { requestDepositAddress: async () => opened } as never;
  const args = {
    quote: { raw: { estimatedPrice: "2000" } },
    destAddress: BURNER,
    refundAddress: REFUND,
  } as never;

  it("is handed out only once Chainflip's own record agrees with what was asked", async () => {
    const { checkedAgainstChainflip } = await backendWith("abc123");
    const open = (read: () => Promise<typeof SERVED | null>) =>
      checkedAgainstChainflip(rail, SOURCE, EGRESS, read, 1, 20).requestDepositAddress(args);

    const reads = [Promise.reject(new Error("HTTP 404")), Promise.resolve(SERVED)];
    await expect(open(() => reads.shift()!)).resolves.toBe(opened);

    await expect(open(async () => null)).rejects.toThrow(/cannot name it/);
    await expect(open(async () => ({ ...SERVED, depositAddress: REFUND }))).rejects.toThrow(
      /deposit address/,
    );
    await expect(open(async () => ({ ...SERVED, destinationAddress: REFUND }))).rejects.toThrow(
      /payout address/,
    );
    await expect(open(async () => ({ ...SERVED, refundAddress: DEPOSIT }))).rejects.toThrow(
      /refund address/,
    );
    await expect(open(async () => ({ ...SERVED, destinationAsset: "DOT" }))).rejects.toThrow(
      /pays out 'DOT'/,
    );
    await expect(open(async () => ({ ...SERVED, sourceAsset: "ETH" }))).rejects.toThrow(
      /takes 'ETH'/,
    );
    await expect(open(async () => ({ ...SERVED, commissionBps: 21 }))).rejects.toThrow(
      /brokers take 21 bps/,
    );
    await expect(open(async () => ({ ...SERVED, minPrice: 1980 }))).rejects.toThrow(
      /minimum price is 1980/,
    );
    await expect(open(() => Promise.reject(new Error("HTTP 404")))).rejects.toThrow("HTTP 404");
  });
});
