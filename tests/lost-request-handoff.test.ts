// A lost request's hand-off is sized live for its tier, so the worker waits for the frozen gate a
// fresh hand-off carries. The worker's defaults stand in when there is nothing to size or a read
// fails, and the tier itself always comes from the slot.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FlowState } from "@getsome/core";

const fees = vi.hoisted(() => ({
  estimateFundingSizing: vi.fn(),
  estimatePsmFundingSizing: vi.fn(),
  estimateStableFundingSizing: vi.fn(),
  estimateDotUsdFundingSizing: vi.fn(),
}));
vi.mock("../lib/funding-fees", () => fees);
vi.mock("../lib/host-chain", () => ({
  ASSET_HUB: { id: "ah" },
  PEOPLE: { id: "people" },
  ASSET_HUB_GENESIS: `0x${"aa".repeat(32)}`,
  PEOPLE_GENESIS: `0x${"bb".repeat(32)}`,
  connectChain: vi.fn(async (target: { id: string }) => ({ target })),
}));
vi.mock("@parity/product-sdk-host", () => ({
  deriveEntropy: vi.fn(),
  getHostLocalStorage: vi.fn(),
  getPaymentManager: vi.fn(),
  requestPermission: vi.fn(),
}));

import { lostRequestHandoff } from "../lib/coinage-live";

const slot = (conversion: Record<string, unknown>, handoffAmount = "12000000"): FlowState =>
  ({ handoffAmount, depositExpiresAt: 99, conversion }) as unknown as FlowState;

const leg = {
  remoteFeeBuffer: 43n,
  dispatchExternal: 1n,
  heldBackExternal: 2n,
  feeAllowanceExternal: 3n,
};

describe("lostRequestHandoff", () => {
  beforeEach(() => {
    for (const fn of Object.values(fees)) fn.mockReset();
  });

  it("sizes the dotUSD tier live and carries its quoted deposit as the gate", async () => {
    fees.estimateDotUsdFundingSizing.mockResolvedValue({
      tier: "dotusd",
      ...leg,
      quotedDeposit: 12_093_512n,
    });
    const handoff = await lostRequestHandoff(
      "dotusd-assethub",
      3,
      "5Burner",
      slot({ tier: "dotusd" }),
    );
    expect(handoff).toMatchObject({
      label: "onramp:eph:dotusd-assethub:3",
      burnerAddress: "5Burner",
      settleAmount: "12000000",
      depositExpiresAt: 99,
      tier: "dotusd",
      remoteFeeBuffer: "43",
      keepNativeForFees: "0",
      quotedDeposit: "12093512",
    });
    expect(fees.estimateDotUsdFundingSizing).toHaveBeenCalledWith(
      expect.objectContaining({ settleAmount: 12_000_000n, probeAddress: "5Burner" }),
    );
  });

  it("sizes the stable pool and PSM tiers with their route, and the native pool with its keep", async () => {
    fees.estimateStableFundingSizing.mockResolvedValue({
      tier: "pool",
      external: "USDC",
      ...leg,
      quotedDeposit: 5_000_000n,
      askedDeposit: 5_100_000n,
    });
    const stable = await lostRequestHandoff(
      "usdc-assethub",
      1,
      "5Burner",
      slot({ tier: "pool", external: "USDC" }),
    );
    expect(stable).toMatchObject({
      tier: "pool",
      external: "USDC",
      quotedDeposit: "5000000",
      keepNativeForFees: "0",
    });
    expect(fees.estimateStableFundingSizing).toHaveBeenCalledWith(
      expect.objectContaining({ route: { tier: "pool", external: "USDC" } }),
    );

    fees.estimatePsmFundingSizing.mockResolvedValue({
      tier: "psm",
      external: "USDT",
      ...leg,
      feeRate: 5000,
      quotedDeposit: 12_100_000n,
    });
    const psm = await lostRequestHandoff(
      "usdt-assethub",
      2,
      "5Burner",
      slot({ tier: "psm", external: "USDT", feeRate: 5000 }),
    );
    expect(psm).toMatchObject({
      tier: "psm",
      external: "USDT",
      feeRate: 5000,
      quotedDeposit: "12100000",
    });

    fees.estimateFundingSizing.mockResolvedValue({
      tier: "pool",
      remoteFeeBuffer: 43n,
      keepNativeForFees: 150_000_000n,
    });
    const native = await lostRequestHandoff("dot-assethub", 4, "5Burner", slot({ tier: "pool" }));
    expect(native).toMatchObject({
      tier: "pool",
      remoteFeeBuffer: "43",
      keepNativeForFees: "150000000",
    });
    expect(native.quotedDeposit).toBeUndefined();
  });

  it("falls back to the worker's defaults when a read fails, the pool sizing gives up, or there is nothing to size", async () => {
    fees.estimateDotUsdFundingSizing.mockRejectedValue(new Error("rpc down"));
    const failed = await lostRequestHandoff(
      "dotusd-assethub",
      3,
      "5Burner",
      slot({ tier: "dotusd" }),
    );
    expect(failed).toMatchObject({
      tier: "dotusd",
      remoteFeeBuffer: "1000",
      keepNativeForFees: "0",
    });
    expect(failed.quotedDeposit).toBeUndefined();

    fees.estimateFundingSizing.mockResolvedValue(null);
    const gaveUp = await lostRequestHandoff("dot-assethub", 4, "5Burner", slot({ tier: "pool" }));
    expect(gaveUp).toMatchObject({
      tier: "pool",
      remoteFeeBuffer: "1000",
      keepNativeForFees: "200000000",
    });

    const nothing = await lostRequestHandoff(
      "dot-assethub",
      5,
      "5Burner",
      slot({ tier: "pool" }, "0"),
    );
    expect(nothing).toMatchObject({ settleAmount: "0", keepNativeForFees: "200000000" });
    expect(fees.estimateFundingSizing).toHaveBeenCalledTimes(1);
  });
});
