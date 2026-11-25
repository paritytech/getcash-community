// What a landed deposit's valuation answers when it has no figure, with the pool and the fee
// reads scripted: nothing to convert is null, a pool with no price is the typed error.

import type { PolkadotClient } from "polkadot-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DepositUnpricedError, quoteDepositValue } from "./sizing";

const mocks = vi.hoisted(() => ({
  estimateFundingProgramFees: vi.fn(),
  quoteUnderlyingOut: vi.fn(),
}));

vi.mock("./cash-transfer", () => ({ chooseCashTransfer: async () => "teleport" }));

vi.mock("./funding-program", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  estimateDestinationFeeCash: async () => 1_200n,
  estimateFundingProgramFees: mocks.estimateFundingProgramFees,
}));

vi.mock("./pipeline", () => ({
  discoverPools: async () => [{ native: {}, underlying: {} }],
  quoteUnderlyingOut: mocks.quoteUnderlyingOut,
}));

const client = { getTypedApi: () => ({}) } as unknown as PolkadotClient;

const valueOf = (deposit: bigint) =>
  quoteDepositValue({
    ahClient: client,
    peopleClient: client,
    underlyingAssetId: 1,
    peopleParaId: 1004,
    probeAddress: "5Probe",
    route: { tier: "pool" },
    deposit,
    slippagePct: 1,
  });

describe("quoteDepositValue", () => {
  beforeEach(() => {
    mocks.estimateFundingProgramFees.mockResolvedValue({
      payFeesNative: 100_000_000n,
      dispatchNative: 50_000_000n,
    });
    mocks.quoteUnderlyingOut.mockReset();
  });

  it("throws the typed error when the pool cannot price what the fees leave", async () => {
    mocks.quoteUnderlyingOut.mockResolvedValue(null);
    await expect(valueOf(7_000_000_000n)).rejects.toBeInstanceOf(DepositUnpricedError);
  });

  it("answers null for a deposit its fees take whole, asking the pool nothing", async () => {
    expect(await valueOf(150_000_000n)).toBeNull();
    expect(mocks.quoteUnderlyingOut).not.toHaveBeenCalled();
  });
});
