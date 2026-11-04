// The network grant asked at launch: Chainflip's hosts on every network the build opens channels on.

import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ saleNetwork: "mainnet" as "mainnet" | "perseverance" }));
const requestPermission = vi.hoisted(() => vi.fn(async (_: unknown) => undefined));

vi.mock("@parity/product-sdk-host", () => ({
  requestPermission,
  getPaymentManager: vi.fn(async () => null),
}));
vi.mock("../lib/host-account", () => ({ isHosted: () => true }));
vi.mock("../lib/coinage", () => ({ readPurseBalance: vi.fn() }));
vi.mock("../lib/chainflip-backend", () => ({ brokerConfigured: () => false, NETWORK: "mainnet" }));
vi.mock("../lib/config", () => ({
  get SALE_SWAP_NETWORK() {
    return env.saleNetwork;
  },
}));

import { frontloadHostPermissions } from "../lib/host-frontload";

const remoteDomains = (): string[] => {
  const call = requestPermission.mock.calls.find(
    ([request]) => (request as { tag: string }).tag === "Remote",
  );
  return (call?.[0] as { value: { domains: string[] } }).value.domains;
};

beforeEach(() => {
  requestPermission.mockClear();
});

describe("frontloadHostPermissions", () => {
  it("asks for mainnet's swap API and RPC once when sales run on mainnet", async () => {
    env.saleNetwork = "mainnet";
    await frontloadHostPermissions();
    expect(remoteDomains().slice(0, 2)).toEqual([
      "chainflip-swap.chainflip.io",
      "rpc.mainnet.chainflip.io",
    ]);
    expect(remoteDomains()).not.toContain("archive.perseverance.chainflip.io");
  });

  it("adds Perseverance's swap API and RPC when sales run there", async () => {
    env.saleNetwork = "perseverance";
    await frontloadHostPermissions();
    expect(remoteDomains().slice(0, 4)).toEqual([
      "chainflip-swap.chainflip.io",
      "rpc.mainnet.chainflip.io",
      "chainflip-swap-perseverance.chainflip.io",
      "archive.perseverance.chainflip.io",
    ]);
  });
});
