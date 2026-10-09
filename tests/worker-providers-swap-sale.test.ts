// The provider a lane sale is followed through: Chainflip's channel is what the key pays and is
// checked, the swap is read on Chainflip until it delivers, then the sale on Meld until it pays out.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readSwapStatus: vi.fn(),
  readChannelRecord: vi.fn(),
  saleStatus: vi.fn(),
}));

vi.mock("@getsome/chainflip/swap-status", () => ({
  readSwapStatus: mocks.readSwapStatus,
  readChannelRecord: mocks.readChannelRecord,
}));

vi.mock("@getsome/meld", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  MELD_SELL_ENABLED: true,
  createMeldClient: () => ({}),
  saleRail: () => ({ channel: vi.fn(), status: mocks.saleStatus }),
}));

vi.mock("../worker/src/host.js", () => ({
  deriveEntropy: vi.fn(),
  getHostProvider: vi.fn(),
  getHostLocalStorage: vi.fn(),
}));

const record = {
  channel: { id: "funding-sell-1", address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" },
  swap: { id: "cf-channel-7", address: "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5" },
  meld: { baseUrl: "https://adapter.test" },
};

describe("a lane sale's provider", () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
  });

  it("checks Chainflip's channel before the key pays", async () => {
    const { railFor } = await import("../worker/src/providers.js");
    mocks.readChannelRecord.mockResolvedValue({ depositAddress: record.swap.address });
    const rail = railFor("meld", record)!;
    await rail.channel!("cf-channel-7");
    expect(mocks.readChannelRecord).toHaveBeenCalledWith("cf-channel-7", undefined, "perseverance");
  });

  it("follows the swap until Chainflip delivers, then the sale", async () => {
    const { railFor } = await import("../worker/src/providers.js");
    const rail = railFor("meld", record)!;
    mocks.readSwapStatus.mockResolvedValue({ status: "swapping" });
    expect(await rail.status("cf-channel-7")).toEqual({ status: "swapping" });
    expect(mocks.saleStatus).not.toHaveBeenCalled();
    mocks.readSwapStatus.mockResolvedValue({ status: "complete" });
    mocks.saleStatus.mockResolvedValue({ status: "receiving", raw: "transaction_seen" });
    expect(await rail.status("cf-channel-7")).toEqual({
      status: "receiving",
      raw: "transaction_seen",
    });
    expect(mocks.saleStatus).toHaveBeenCalledWith("funding-sell-1");
  });

  it("follows a sale with no lane on Meld alone", async () => {
    const { railFor } = await import("../worker/src/providers.js");
    const rail = railFor("meld", { ...record, swap: undefined })!;
    mocks.saleStatus.mockResolvedValue({ status: "complete" });
    expect(await rail.status("funding-sell-1")).toEqual({ status: "complete" });
    expect(mocks.readSwapStatus).not.toHaveBeenCalled();
  });
});
