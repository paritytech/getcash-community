// Sizing a sale through an offramp lane over a scripted PSM and Chainflip: the USDT the redeem
// lands less a margin and the key's fee is what the swap is quoted on, the provider is promised the
// fill-or-kill floor of that quote, and the channel is opened only while today's floor still
// covers the promise. And a direct sale of USDT over the same redeem: the provider is promised what
// lands less the margin, the payment's fee and USDT's minimum balance.

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
  channelsOpen: true,
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
  return {
    NETWORK: "mainnet",
    mainnetSdk: vi.fn(),
    saleSwapSdk: async () => sdk,
    saleChannelsOpen: () => cf.channelsOpen,
  };
});
vi.mock("../lib/host-chain", () => ({
  ASSET_HUB: "asset-hub",
  PEOPLE: "people",
  ASSET_HUB_GENESIS: "0xah",
  PEOPLE_GENESIS: "0xpe",
  connectChain: async () => ({
    getTypedApi: () => ({
      query: { Assets: { Asset: { getValue: async () => ({ min_balance: 70_000n }) } } },
    }),
  }),
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
import { destinationEarmark } from "@getsome/funding";
import { ASSET_HUB_FEE_BUFFER_CASH, psmRedeemOut } from "@getsome/withdraw";
import {
  openSwapSaleChannel,
  sizeSwapSale,
  sizeUsdtSale,
  usdtSaleFundable,
} from "../lib/withdraw-live";

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
    cf.channelsOpen = true;
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
    // What the provider is promised keeps 1% under that for the seller's KYC.
    expect(size.promise).toBe(((size.commit * 9_900n) / 10_000n / 100n) * 100n);
  });

  it("opens the swap to the provider's address with the promise's slippage", async () => {
    const { promise } = await sizeSwapSale(AMOUNT, lane);
    const channel = await openSwapSaleChannel({
      amount: AMOUNT,
      lane,
      committed: promise,
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

  it("still opens after the quote slipped while the seller verified, within the KYC margin", async () => {
    const { promise } = await sizeSwapSale(AMOUNT, lane);
    cf.rate = 988_000n; // half a percent worse than at confirm
    const channel = await openSwapSaleChannel({
      amount: AMOUNT,
      lane,
      committed: promise,
      providerAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      keyPublicKeyHex: `0x${"07".repeat(32)}`,
    });
    expect(channel).not.toBeNull();
  });

  it("opens nothing once today's floor no longer covers the promise", async () => {
    const { promise } = await sizeSwapSale(AMOUNT, lane);
    cf.rate = 980_000n;
    const channel = await openSwapSaleChannel({
      amount: AMOUNT,
      lane,
      committed: promise,
      providerAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      keyPublicKeyHex: `0x${"07".repeat(32)}`,
    });
    expect(channel).toBeNull();
    expect(cf.opened).toEqual([]);
  });

  it("refuses to size a lane sale whose channel this build cannot open, before any quote", async () => {
    cf.channelsOpen = false;
    await expect(sizeSwapSale(AMOUNT, lane)).rejects.toThrow("Swap channels cannot be opened");
    expect(cf.quoted).toEqual([]);
  });

  it("keeps the lane's delivery-fee headroom out of the promise", async () => {
    cf.egressFee = 25_000n; // 0.025 USDC on Arbitrum, kept three times over
    const arbitrum = laneById("usdc-arbitrum");
    const { commit } = await sizeSwapSale(AMOUNT, arbitrum);
    const kept = (USDT_IN * 993_000n) / 1_000_000n - 2n * 25_000n;
    expect(commit).toBe(((kept * 9_950n) / 10_000n / 100n) * 100n);
  });
});

describe("a direct sale of USDT", () => {
  beforeEach(() => {
    cf.quoted.length = 0;
  });

  /** What the redeem lands for `amount` CASH, with the 0.45 of fees out first. */
  const landedFor = (amount: bigint) => {
    const sold = amount - 450_000n;
    return {
      sold,
      landed: psmRedeemOut(sold - destinationEarmark(sold, ASSET_HUB_FEE_BUFFER_CASH), 1_000),
    };
  };
  /** The promise: what lands less 0.2%, the 0.1 USDT fee and the 0.07 minimum balance, cut to four
   *  decimals. */
  const commitFor = (landed: bigint) => (((landed * 9_980n) / 10_000n - 170_000n) / 100n) * 100n;

  it("promises what the redeem lands less the margin, the fee and USDT's minimum balance", async () => {
    const size = await sizeUsdtSale(AMOUNT);
    expect(size.route).toEqual({ tier: "psm", external: "USDT", feeRate: 1_000 });
    expect(size.commit).toBe(commitFor(LANDED));
    // About 0.27 USDT is left once the provider is paid: too little to send back.
    expect(LANDED - size.commit - 100_000n).toBeLessThan(1_000_000n);
    expect(size.backCash).toBe(0n);
    // No swap is quoted for it.
    expect(cf.quoted).toEqual([]);
  });

  it("expects back the CASH share of what is left once it is worth the way home", async () => {
    const amount = 1_000_000_000n;
    const { sold, landed } = landedFor(amount);
    const size = await sizeUsdtSale(amount);
    expect(size.commit).toBe(commitFor(landed));
    const left = landed - size.commit - 100_000n;
    expect(left).toBeGreaterThanOrEqual(1_000_000n);
    expect(size.backCash).toBe((sold * left) / landed);
  });

  it("is fundable while today's redeem still covers the promise", async () => {
    const { commit } = await sizeUsdtSale(AMOUNT);
    expect(await usdtSaleFundable(AMOUNT, commit)).toBe(true);
    expect(await usdtSaleFundable(AMOUNT, commit + 100n)).toBe(false);
  });

  it("refuses an amount the fees take whole", async () => {
    await expect(sizeUsdtSale(500_000n)).rejects.toThrow("does not cover the network fees");
  });
});
