// The chain client cache: one client per chain, dialed once, and dropped on eviction so the next
// connect dials afresh.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { dialed, specs } = vi.hoisted(() => ({
  /** Every client created, in order, with the genesis it was asked for and whether it is gone. */
  dialed: [] as { genesis: string; destroyed: boolean }[],
  /** How the next clients answer the liveness check, in order; one with none answers at once. */
  specs: [] as (() => Promise<{ genesisHash: string }>)[],
}));

vi.mock("@parity/product-sdk-host", () => ({
  isInsideContainerSync: () => true,
  getHostProvider: async (genesis: string) => ({ genesis }),
}));
vi.mock("polkadot-api", () => ({
  createClient: (provider: { genesis: string }) => {
    const client = { genesis: provider.genesis, destroyed: false };
    dialed.push(client);
    const spec = specs.shift();
    return {
      getChainSpecData: spec ?? (async () => ({ genesisHash: provider.genesis })),
      getFinalizedBlock: async () => ({ number: 1 }),
      destroy: () => {
        client.destroyed = true;
      },
    };
  },
}));

/** Lets a destroy chained on a cached client's promise run. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("host chain clients", () => {
  beforeEach(() => {
    vi.resetModules();
    dialed.length = 0;
    specs.length = 0;
  });

  it("keeps the fresh client when a dial evicted while it ran fails afterwards", async () => {
    const { ASSET_HUB, connectChain, evictChain } = await import("../lib/host-chain");
    let refuse: (e: Error) => void = () => {};
    specs.push(() => new Promise((_, reject) => (refuse = reject)));
    connectChain(ASSET_HUB).catch(() => {});
    // Evicted once its client exists and the dial waits on the chain: two dials loading the
    // client modules at once do not both get the stand-ins here.
    for (let turn = 0; turn < 100 && dialed.length === 0; turn++) await settled();
    evictChain(ASSET_HUB);
    const fresh = await connectChain(ASSET_HUB);

    refuse(new Error("the old connection gave out"));
    await settled();
    expect(await connectChain(ASSET_HUB)).toBe(fresh);
    expect(dialed).toHaveLength(2);
  });

  it("evicts one chain's client alone, and the next connect dials it afresh", async () => {
    const { ASSET_HUB, PEOPLE, connectChain, evictChain } = await import("../lib/host-chain");
    const assetHub = await connectChain(ASSET_HUB);
    const people = await connectChain(PEOPLE);
    expect(await connectChain(ASSET_HUB)).toBe(assetHub);

    evictChain(ASSET_HUB);
    await settled();
    expect(dialed.map(({ destroyed }) => destroyed)).toEqual([true, false]);
    expect(await connectChain(ASSET_HUB)).not.toBe(assetHub);
    expect(await connectChain(PEOPLE)).toBe(people);
    expect(dialed).toHaveLength(3);
  });

  it("evicts every chain's client at once", async () => {
    const { ASSET_HUB, PEOPLE, connectChain, evictChains } = await import("../lib/host-chain");
    await connectChain(ASSET_HUB);
    await connectChain(PEOPLE);

    evictChains();
    await settled();
    expect(dialed.map(({ destroyed }) => destroyed)).toEqual([true, true]);
    await connectChain(PEOPLE);
    expect(dialed).toHaveLength(3);
  });
});
