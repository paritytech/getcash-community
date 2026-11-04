// A lane sale's provider: the key's channel checked against Meld, the factory and the CCM message.

import { encodeSaleMessage } from "@getsome/chainflip/ccm";
import vectors from "../packages/sale-vault-proxy/vectors.json";
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

const FACTORY = `0x${"11".repeat(20)}`;
const PROXY = `0x${"ab".repeat(20)}`;
const CLAIMER = `0x${"55".repeat(20)}`;
/** The payment deadline the swap's message seals. */
const PAYMENT_EXPIRES_AT = 1_798_761_600_500;

const record = {
  channel: {
    id: "funding-sell-1",
    address: `0x${"81".repeat(20)}`,
    amount: "25000000",
  },
  keyPublicKeyHex: `0x${"07".repeat(32)}`,
  swap: {
    id: "cf-channel-7",
    address: "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5",
    proxyFactory: FACTORY,
    proxyAddress: PROXY,
    claimerAddress: CLAIMER,
    paymentExpiresAt: PAYMENT_EXPIRES_AT,
  },
  meld: { baseUrl: "https://adapter.test" },
};

/** The CCM message the sale's own terms encode. */
const MESSAGE = encodeSaleMessage({
  fundingRequestId: record.channel.id,
  recipient: record.channel.address,
  committed: 25_000_000n,
  home: record.keyPublicKeyHex,
  paymentExpiresAt: PAYMENT_EXPIRES_AT,
  claimer: CLAIMER,
}).toLowerCase();

describe("a lane sale's provider", () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
  });

  const flip = {
    depositAddress: record.swap.address,
    destinationAddress: FACTORY.toUpperCase().replace("0X", "0x"),
    ccmMessage: MESSAGE,
    ccmGasBudget: vectors.gas.CCM_GAS_BUDGET,
  };
  const order = {
    depositAddress: record.channel.address,
    payout: "off-chain",
    expired: false,
    expectedAmount: 25_000_000n,
    walletAddress: PROXY.toUpperCase().replace("0X", "0x"),
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
    [
      "Chainflip pays out to the provider",
      { ...flip, destinationAddress: record.channel.address },
      /not the sale vault proxy factory/,
    ],
    [
      "the CCM message is another sale's",
      { ...flip, ccmMessage: MESSAGE.replace(/.$/, (c) => (c === "0" ? "1" : "0")) },
      /another sale's CCM message/,
    ],
    ["the CCM message is missing", { ...flip, ccmMessage: "" }, /no CCM message/],
    [
      "the CCM gas budget is another",
      { ...flip, ccmGasBudget: "255000" },
      new RegExp(`gas budget of 255000, not ${vectors.gas.CCM_GAS_BUDGET}`),
    ],
    ["the CCM gas budget is missing", { ...flip, ccmGasBudget: "" }, /gas budget of none/],
    ["the CCM gas budget is malformed", { ...flip, ccmGasBudget: "0xzz" }, /gas budget of 0xzz/],
  ])("refuses the channel when %s", async (_, chainflip, message) => {
    const { railFor } = await import("../worker/src/providers.js");
    const { ChannelMismatchError } = await import("@getsome/withdraw");
    mocks.readChannelRecord.mockResolvedValue(chainflip);
    mocks.saleChannel.mockResolvedValue(order);
    const read = railFor("meld", record)!.channel!("cf-channel-7");
    await expect(read).rejects.toThrow(message);
    await expect(read).rejects.toBeInstanceOf(ChannelMismatchError);
  });

  it("takes the measured CCM gas budget written in hex", async () => {
    const { railFor } = await import("../worker/src/providers.js");
    const hex = `0x${BigInt(vectors.gas.CCM_GAS_BUDGET).toString(16)}`;
    mocks.readChannelRecord.mockResolvedValue({ ...flip, ccmGasBudget: hex });
    mocks.saleChannel.mockResolvedValue(order);
    await expect(railFor("meld", record)!.channel!("cf-channel-7")).resolves.toMatchObject({
      ccmGasBudget: hex,
    });
  });

  it("refuses every channel when the job names no factory", async () => {
    const { railFor } = await import("../worker/src/providers.js");
    const { ChannelMismatchError } = await import("@getsome/withdraw");
    mocks.readChannelRecord.mockResolvedValue(flip);
    mocks.saleChannel.mockResolvedValue(order);
    const unnamed = {
      ...record,
      swap: { id: record.swap.id, address: record.swap.address, proxyAddress: PROXY },
    };
    const read = railFor("meld", unnamed)!.channel!("cf-channel-7");
    await expect(read).rejects.toThrow(/names no sale vault proxy factory/);
    await expect(read).rejects.toBeInstanceOf(ChannelMismatchError);
  });

  it("refuses a sale whose terms cannot be a CCM message", async () => {
    const { railFor } = await import("../worker/src/providers.js");
    const solana = {
      ...record,
      channel: { ...record.channel, address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" },
    };
    mocks.readChannelRecord.mockResolvedValue(flip);
    mocks.saleChannel.mockResolvedValue({ ...order, depositAddress: solana.channel.address });
    await expect(railFor("meld", solana)!.channel!("cf-channel-7")).rejects.toThrow(
      /has no CCM message/,
    );
  });

  it("refuses a channel whose message seals another payment deadline", async () => {
    const { railFor } = await import("../worker/src/providers.js");
    mocks.readChannelRecord.mockResolvedValue(flip);
    mocks.saleChannel.mockResolvedValue(order);
    const later = {
      ...record,
      swap: { ...record.swap, paymentExpiresAt: PAYMENT_EXPIRES_AT + 1_000 },
    };
    await expect(railFor("meld", later)!.channel!("cf-channel-7")).rejects.toThrow(
      /another sale's CCM message/,
    );
  });

  it("refuses a channel whose message seals another claimer", async () => {
    const { railFor } = await import("../worker/src/providers.js");
    mocks.readChannelRecord.mockResolvedValue(flip);
    mocks.saleChannel.mockResolvedValue(order);
    const other = { ...record, swap: { ...record.swap, claimerAddress: `0x${"66".repeat(20)}` } };
    await expect(railFor("meld", other)!.channel!("cf-channel-7")).rejects.toThrow(
      /another sale's CCM message/,
    );
  });

  it("refuses a swap that names no payment deadline for its message", async () => {
    const { railFor } = await import("../worker/src/providers.js");
    const { paymentExpiresAt: _dropped, ...swap } = record.swap;
    mocks.readChannelRecord.mockResolvedValue(flip);
    mocks.saleChannel.mockResolvedValue(order);
    await expect(railFor("meld", { ...record, swap })!.channel!("cf-channel-7")).rejects.toThrow(
      /has no CCM message: payment deadline/,
    );
  });

  it.each([
    ["Meld cannot name the sale", null, /cannot name sale/],
    [
      "Meld takes deposits elsewhere",
      { ...order, depositAddress: "elsewhere" },
      /takes deposits at/,
    ],
    ["Meld expects another amount", { ...order, expectedAmount: 1n }, /expects 1/],
    [
      "Meld pins another wallet",
      { ...order, walletAddress: `0x${"cd".repeat(20)}` },
      /not the key's proxy/,
    ],
    ["Meld pins no wallet", { ...order, walletAddress: undefined }, /not the key's proxy/],
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
