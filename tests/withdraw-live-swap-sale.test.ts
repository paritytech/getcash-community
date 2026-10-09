// Sizing a sale through an offramp lane over a scripted PSM and Chainflip: the USDT the redeem
// lands less a margin and the key's fee is what the swap is quoted on, the provider is promised the
// fill-or-kill floor of that quote, and the channel is opened only while today's floor still
// covers the promise.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@novasamatech/host-api", () => ({
  PaymentRequestErr: class PaymentRequestErr extends Error {},
  PaymentStatusErr: class PaymentStatusErr extends Error {},
}));
vi.mock("../lib/host-payments", () => ({
  requestPayment: vi.fn(),
  subscribePaymentStatus: vi.fn(),
}));

/** Chainflip delivers `rate` per million of what it is quoted on. */
const cf = vi.hoisted(() => ({
  rate: 993_000n,
  egressFee: 0n,
  quoted: [] as string[],
  opened: [] as unknown[],
}));
vi.mock("../lib/chainflip-backend", () => {
  const sdk = {
    getQuoteV2: async (args: { amount: string }) => {
      cf.quoted.push(args.amount);
      return {
        quotes: [
          {
            type: "REGULAR",
            egressAmount: String((BigInt(args.amount) * cf.rate) / 1_000_000n),
            includedFees: [{ type: "EGRESS", amount: String(cf.egressFee) }],
          },
        ],
      };
    },
    requestDepositAddressV2: async (args: unknown) => {
      cf.opened.push(args);
      return { depositAddress: "15ChannelOnAssetHub", depositChannelId: "cf-7" };
    },
  };
  return { NETWORK: "mainnet", mainnetSdk: vi.fn(), saleSwapSdk: async () => sdk };
});
vi.mock("../lib/host-chain", () => ({
  ASSET_HUB: "asset-hub",
  PEOPLE: "people",
  ASSET_HUB_GENESIS: "0xah",
  PEOPLE_GENESIS: "0xpe",
  connectChain: async () => ({ getTypedApi: () => ({}) }),
}));
vi.mock("@getsome/funding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@getsome/funding")>()),
  chooseCashTransfer: async () => "teleport",
  chooseRoute: async () => ({ tier: "psm", external: "USDT", feeRate: 1_000 }),
}));
vi.mock("@getsome/withdraw", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@getsome/withdraw")>()),
  estimateDirectFeesCash: async () => 450_000n,
}));

import { laneById } from "@getsome/offramp";
import { psmRedeemOut } from "@getsome/withdraw";
import { openSwapSaleChannel, sizeSwapSale } from "../lib/withdraw-live";

const lane = laneById("usdt-solana");
const AMOUNT = 100_000_000n;
/** 100 CASH less 0.45 of fees, less Asset Hub's 1% earmark, redeemed at 0.1%. */
const LANDED = psmRedeemOut(99_550_000n - 995_500n, 1_000);
/** Less 0.2% for what the estimate cannot see and the key's 0.1 USDT fee. */
const USDT_IN = (LANDED * 9_980n) / 10_000n - 100_000n;

describe("a sale through an offramp lane", () => {
  beforeEach(() => {
    cf.rate = 993_000n;
    cf.egressFee = 0n;
    cf.quoted.length = 0;
    cf.opened.length = 0;
  });

  it("quotes the swap on the least USDT the key lands and promises its floor", async () => {
    const size = await sizeSwapSale(AMOUNT, lane);
    expect(size.route).toEqual({ tier: "psm", external: "USDT", feeRate: 1_000 });
    expect(size.usdtIn).toBe(USDT_IN);
    expect(cf.quoted).toEqual([USDT_IN.toString()]);
    const floor = (((USDT_IN * 993_000n) / 1_000_000n) * 9_950n) / 10_000n;
    // Cut to the four decimals a sale commits.
    expect(size.commit).toBe((floor / 100n) * 100n);
  });

  it("opens the swap to the provider's address with the promise's slippage", async () => {
    const { commit } = await sizeSwapSale(AMOUNT, lane);
    const channel = await openSwapSaleChannel({
      amount: AMOUNT,
      lane,
      committed: commit,
      providerAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      keyPublicKeyHex: `0x${"07".repeat(32)}`,
    });
    expect(channel).toMatchObject({
      id: "cf-7",
      address: "15ChannelOnAssetHub",
      amount: (USDT_IN + 100_000n).toString(),
    });
    expect(cf.opened[0]).toMatchObject({
      destAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      fillOrKillParams: { slippageTolerancePercent: "0.5", retryDurationMinutes: 30 },
    });
  });

  it("opens nothing once today's floor no longer covers the promise", async () => {
    const { commit } = await sizeSwapSale(AMOUNT, lane);
    cf.rate = 980_000n;
    const channel = await openSwapSaleChannel({
      amount: AMOUNT,
      lane,
      committed: commit,
      providerAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      keyPublicKeyHex: `0x${"07".repeat(32)}`,
    });
    expect(channel).toBeNull();
    expect(cf.opened).toEqual([]);
  });

  it("keeps the lane's delivery-fee headroom out of the promise", async () => {
    cf.egressFee = 25_000n; // 0.025 USDC on Arbitrum, kept three times over
    const arbitrum = laneById("usdc-arbitrum");
    const { commit } = await sizeSwapSale(AMOUNT, arbitrum);
    const kept = (USDT_IN * 993_000n) / 1_000_000n - 2n * 25_000n;
    expect(commit).toBe(((kept * 9_950n) / 10_000n / 100n) * 100n);
  });
});
