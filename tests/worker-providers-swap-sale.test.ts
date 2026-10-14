// The provider a lane sale is followed through: Chainflip's channel is what the key pays, checked
// against Meld's own record of the sale; the swap is read on Chainflip until it delivers, then the
// sale on Meld until it pays out.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readSwapStatus: vi.fn(),
  readChannelRecord: vi.fn(),
  saleStatus: vi.fn(),
  saleChannel: vi.fn(),
}));

vi.mock("@getsome/chainflip/swap-status", () => ({
  readSwapStatus: mocks.readSwapStatus,
  readChannelRecord: mocks.readChannelRecord,
}));

vi.mock("@getsome/meld", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  MELD_SELL_ENABLED: true,
  createMeldClient: () => ({}),
  saleRail: () => ({ channel: mocks.saleChannel, status: mocks.saleStatus }),
}));

vi.mock("../worker/src/host.js", () => ({
  deriveEntropy: vi.fn(),
  getHostProvider: vi.fn(),
  getHostLocalStorage: vi.fn(),
}));

const record = {
  channel: {
    id: "funding-sell-1",
    address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    amount: "25000000",
  },
  swap: { id: "cf-channel-7", address: "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5" },
  meld: { baseUrl: "https://adapter.test" },
};

describe("a lane sale's provider", () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
  });

  const flip = { depositAddress: record.swap.address, destinationAddress: record.channel.address };
  const order = {
    depositAddress: record.channel.address,
    payout: "off-chain",
    expired: false,
    expectedAmount: 25_000_000n,
  };

  it("checks Chainflip's channel and Meld's sale before the key pays", async () => {
    const { railFor } = await import("../worker/src/providers.js");
    mocks.readChannelRecord.mockResolvedValue(flip);
    mocks.saleChannel.mockResolvedValue(order);
    const rail = railFor("meld", record)!;
    expect(await rail.channel!("cf-channel-7")).toEqual(flip);
    expect(mocks.readChannelRecord).toHaveBeenCalledWith("cf-channel-7", undefined, "perseverance");
    expect(mocks.saleChannel).toHaveBeenCalledWith("funding-sell-1");
  });

  it.each([
    ["Meld cannot name the sale", null, /cannot name sale/],
    [
      "Meld takes deposits elsewhere",
      { ...order, depositAddress: "elsewhere" },
      /takes deposits at/,
    ],
    ["Meld expects another amount", { ...order, expectedAmount: 1n }, /expects 1/],
  ])("refuses the channel when %s", async (_, meld, message) => {
    const { railFor } = await import("../worker/src/providers.js");
    const { ChannelMismatchError } = await import("@getsome/withdraw");
    mocks.readChannelRecord.mockResolvedValue(flip);
    mocks.saleChannel.mockResolvedValue(meld);
    const read = railFor("meld", record)!.channel!("cf-channel-7");
    await expect(read).rejects.toThrow(message);
    await expect(read).rejects.toBeInstanceOf(ChannelMismatchError);
  });

  it("reads the channel as expired once Meld has closed the sale", async () => {
    const { railFor } = await import("../worker/src/providers.js");
    mocks.readChannelRecord.mockResolvedValue(flip);
    mocks.saleChannel.mockResolvedValue({ ...order, expired: true });
    expect(await railFor("meld", record)!.channel!("cf-channel-7")).toEqual({
      ...flip,
      expired: true,
    });
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
      swapDelivered: true,
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
