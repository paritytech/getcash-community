import { describe, expect, it, vi } from "vitest";
import { SwapSDK } from "@chainflip/sdk/swap";
import vectors from "../../sale-vault-proxy/vectors.json";
import {
  isEvmPayeeAddress,
  predictSaleVaultProxy,
  SALE_VAULT_PROXY_CCM_GAS_BUDGET,
  SALE_VAULT_PROXY_CHAIN_IDS,
  saleVaultProxyContractsOf,
  saleVaultProxyDelaysMs,
  saleVaultProxyMatches,
  saleVaultProxyMinSale,
  sameEvmAddress,
  type SaleVaultProxyDeployment,
} from "./sale-vault-proxy";

const FACTORY = `0x${"11".repeat(20)}`;
const IMPLEMENTATION = `0x${"22".repeat(20)}`;
const HOME_AB = `0x${"ab".repeat(32)}`;
const HOME_ALICE = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";

const CLAIMER = `0x${"33".repeat(20)}`;

describe("predictSaleVaultProxy", () => {
  it("derives the CREATE2 address the factory deploys a home and claimer's proxy at", () => {
    expect(predictSaleVaultProxy(FACTORY, IMPLEMENTATION, HOME_AB, CLAIMER)).toBe(
      "0xcc7d876cC298b0e30157D6c2656FBC6Fc66deeC7",
    );
    expect(predictSaleVaultProxy(FACTORY, IMPLEMENTATION, HOME_ALICE, CLAIMER)).toBe(
      "0xB7967f92Fd611b5fF68b6A043DAf49034Cad476B",
    );
  });

  it("derives the address the contract's own predict answers", () => {
    for (const v of [...vectors.predict.pinned, vectors.predict.local]) {
      expect(predictSaleVaultProxy(v.factory, v.implementation, v.home, v.claimer)).toBe(v.proxy);
    }
  });

  it("answers EIP-55 whatever the casing of its inputs", () => {
    expect(
      predictSaleVaultProxy(
        FACTORY.toUpperCase().replace("0X", "0x"),
        IMPLEMENTATION,
        HOME_ALICE,
        CLAIMER,
      ),
    ).toBe("0xB7967f92Fd611b5fF68b6A043DAf49034Cad476B");
    expect(
      predictSaleVaultProxy(FACTORY, IMPLEMENTATION, HOME_ALICE.toUpperCase().slice(2), CLAIMER),
    ).toBe("0xB7967f92Fd611b5fF68b6A043DAf49034Cad476B");
  });

  it("gives each home and each claimer its own proxy", () => {
    const proxy = predictSaleVaultProxy(FACTORY, IMPLEMENTATION, HOME_AB, CLAIMER);
    expect(predictSaleVaultProxy(FACTORY, IMPLEMENTATION, HOME_ALICE, CLAIMER)).not.toBe(proxy);
    expect(predictSaleVaultProxy(FACTORY, IMPLEMENTATION, HOME_AB, `0x${"44".repeat(20)}`)).toBe(
      "0xD9dDD58FFB4B3c93C40115c7F03c7e3d2277Cd1a",
    );
  });

  it("refuses a home that is not 32 bytes", () => {
    expect(() => predictSaleVaultProxy(FACTORY, IMPLEMENTATION, "0xabcd", CLAIMER)).toThrow(
      /32 bytes/,
    );
    expect(() => predictSaleVaultProxy(FACTORY, IMPLEMENTATION, `${HOME_AB}ab`, CLAIMER)).toThrow(
      /32 bytes/,
    );
  });

  it("refuses a claimer that is not an address, or is zero", () => {
    for (const claimer of ["0x1234", `0x${"33".repeat(32)}`, "33".repeat(20), ""]) {
      expect(() => predictSaleVaultProxy(FACTORY, IMPLEMENTATION, HOME_AB, claimer)).toThrow(
        /claimer must be a 20-byte/,
      );
    }
    expect(() =>
      predictSaleVaultProxy(FACTORY, IMPLEMENTATION, HOME_AB, `0x${"00".repeat(20)}`),
    ).toThrow(/zero address/);
  });

  it("refuses a factory or implementation that is not an address", () => {
    expect(() => predictSaleVaultProxy("0x1234", IMPLEMENTATION, HOME_AB, CLAIMER)).toThrow(
      /factory/,
    );
    expect(() => predictSaleVaultProxy(FACTORY, "nope", HOME_AB, CLAIMER)).toThrow(
      /implementation/,
    );
  });
});

describe("isEvmPayeeAddress", () => {
  it("takes an address in one case or under its EIP-55 checksum", () => {
    expect(isEvmPayeeAddress("0xfb63126B916e3bD2497702a0139AD2B344aC7536")).toBe(true);
    expect(isEvmPayeeAddress("0xfb63126b916e3bd2497702a0139ad2b344ac7536")).toBe(true);
    expect(isEvmPayeeAddress("0xFB63126B916E3BD2497702A0139AD2B344AC7536")).toBe(true);
  });

  it("refuses a mistyped checksum, the zero address and anything not an address", () => {
    expect(isEvmPayeeAddress("0xfb63126B916e3bD2497702a0139AD2B344aC7537")).toBe(false);
    expect(isEvmPayeeAddress("0xFb63126B916e3bD2497702a0139AD2B344aC7536")).toBe(false);
    expect(isEvmPayeeAddress(`0x${"0".repeat(40)}`)).toBe(false);
    for (const value of ["", "0x1234", "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY", 7]) {
      expect(isEvmPayeeAddress(value)).toBe(false);
    }
  });
});

describe("sameEvmAddress", () => {
  it("compares addresses without regard to casing", () => {
    expect(
      sameEvmAddress(
        "0xfb63126B916e3bD2497702a0139AD2B344aC7536",
        "0xfb63126b916e3bd2497702a0139ad2b344ac7536",
      ),
    ).toBe(true);
    expect(sameEvmAddress(FACTORY, IMPLEMENTATION)).toBe(false);
  });

  it("never matches something that is not an address", () => {
    expect(sameEvmAddress("", "")).toBe(false);
    expect(sameEvmAddress("0x1234", "0x1234")).toBe(false);
  });
});

describe("saleVaultProxyMatches", () => {
  const deployment: SaleVaultProxyDeployment = {
    chainId: 421614,
    factory: FACTORY,
    implementation: IMPLEMENTATION,
    minSale: 1_250_000n,
  };
  const target = { chainId: 421614, factory: FACTORY, implementation: IMPLEMENTATION };

  it("accepts the configured deployment in any casing", () => {
    expect(saleVaultProxyMatches(deployment, target)).toBe(true);
    expect(
      saleVaultProxyMatches(deployment, {
        ...target,
        factory: FACTORY.toUpperCase().replace("0X", "0x"),
      }),
    ).toBe(true);
  });

  it("refuses another chain, factory or implementation", () => {
    expect(saleVaultProxyMatches(deployment, { ...target, chainId: 42161 })).toBe(false);
    expect(saleVaultProxyMatches(deployment, { ...target, factory: IMPLEMENTATION })).toBe(false);
    expect(saleVaultProxyMatches(deployment, { ...target, implementation: FACTORY })).toBe(false);
  });
});

describe("saleVaultProxyContractsOf", () => {
  const raw = { chainId: "421614", factory: FACTORY, implementation: IMPLEMENTATION };

  it("reads a chain id as text or a number, and two addresses", () => {
    const contracts = { chainId: 421614, factory: FACTORY, implementation: IMPLEMENTATION };
    expect(saleVaultProxyContractsOf(raw)).toEqual(contracts);
    expect(saleVaultProxyContractsOf({ ...raw, chainId: 421614, factory: ` ${FACTORY} ` })).toEqual(
      contracts,
    );
  });

  it("refuses a missing or malformed value", () => {
    expect(saleVaultProxyContractsOf({})).toBeNull();
    expect(saleVaultProxyContractsOf({ ...raw, chainId: "0" })).toBeNull();
    expect(saleVaultProxyContractsOf({ ...raw, chainId: 1.5 })).toBeNull();
    expect(saleVaultProxyContractsOf({ ...raw, chainId: "99999999999999999999" })).toBeNull();
    expect(saleVaultProxyContractsOf({ ...raw, factory: "0x1234" })).toBeNull();
    expect(saleVaultProxyContractsOf({ ...raw, implementation: undefined })).toBeNull();
    expect(saleVaultProxyContractsOf({ ...raw, implementation: 7 })).toBeNull();
    expect(saleVaultProxyContractsOf({ ...raw, factory: `0x${"00".repeat(20)}` })).toBeNull();
    expect(
      saleVaultProxyContractsOf({ ...raw, implementation: `0x${"00".repeat(20)}` }),
    ).toBeNull();
  });
});

describe("saleVaultProxyMinSale", () => {
  it("reads every Chainflip network's least sale from the proxy networks", () => {
    for (const chainId of Object.values(SALE_VAULT_PROXY_CHAIN_IDS)) {
      const network = (vectors.networks as Record<string, { minSale: string }>)[String(chainId)]!;
      expect(saleVaultProxyMinSale(chainId)).toBe(BigInt(network.minSale));
    }
  });

  it("is null on a chain with no proxy network", () => {
    expect(saleVaultProxyMinSale(1)).toBeNull();
  });
});

describe("saleVaultProxyDelaysMs", () => {
  it("reads every Chainflip network's release clocks from the proxy networks", () => {
    for (const chainId of Object.values(SALE_VAULT_PROXY_CHAIN_IDS)) {
      const network = (
        vectors.networks as Record<string, { releaseDelay: string; staleDelay: string }>
      )[String(chainId)]!;
      expect(saleVaultProxyDelaysMs(chainId)).toEqual({
        releaseDelayMs: Number(network.releaseDelay) * 1000,
        staleDelayMs: Number(network.staleDelay) * 1000,
      });
    }
  });

  it("is null on a chain with no proxy network", () => {
    expect(saleVaultProxyDelaysMs(1)).toBeNull();
  });
  it("throws on an entry missing its clocks instead of returning NaN", async () => {
    vi.resetModules();
    vi.doMock("../../sale-vault-proxy/vectors.json", () => ({
      default: { ...vectors, networks: { "1": { usdc: "0x", minSale: "1" } } },
    }));
    try {
      const fresh = await import("./sale-vault-proxy");
      expect(() => fresh.saleVaultProxyDelaysMs(1)).toThrow(/releaseDelay/);
    } finally {
      vi.doUnmock("../../sale-vault-proxy/vectors.json");
      vi.resetModules();
    }
  });
});

describe("SALE_VAULT_PROXY_CCM_GAS_BUDGET", () => {
  it("budgets the CCM gas the contract's gas test measured", () => {
    expect(SALE_VAULT_PROXY_CCM_GAS_BUDGET).toBe(vectors.gas.CCM_GAS_BUDGET);
  });
});

describe("SALE_VAULT_PROXY_CHAIN_IDS", () => {
  it("names the Arbitrum chain the Chainflip SDK names for each network", async () => {
    for (const [network, chainId] of Object.entries(SALE_VAULT_PROXY_CHAIN_IDS)) {
      const sdk = new SwapSDK({ network: network as "mainnet" | "perseverance" });
      // Offline: only the chain list is read, never the live environment
      Object.assign(sdk, {
        getStateChainEnvironment: async () => ({
          ingressEgress: { witnessSafetyMargins: {} },
          swapping: { maxSwapRetryDurationBlocks: null },
        }),
        getSupportedAssets: async () => ["ArbUsdc"],
      });
      const [arbitrum] = await sdk.getChains();
      expect(arbitrum).toMatchObject({ chain: "Arbitrum", evmChainId: chainId });
    }
  });
});
