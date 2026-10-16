// Sizing a sale through an offramp lane over a scripted PSM and Chainflip: the USDT the redeem
// lands less what the key's sweep costs is what the swap is quoted on, the provider is promised the
// fill-or-kill floor of that quote, and the channel is opened only while today's floor still
// covers the promise. A direct sale of USDT is sized in withdraw-live-sale-sizing.

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
/** Asset Hub as the sizing reads it: the native priced at a thousandth in USDT, the payment's and
 *  the redeem's fees, the USDT min_balance and the PSM pair's floors. */
vi.mock("../lib/host-chain", () => ({
  ASSET_HUB: "asset-hub",
  PEOPLE: "people",
  ASSET_HUB_GENESIS: "0xah",
  PEOPLE_GENESIS: "0xpe",
  connectChain: async () => ({
    getTypedApi: () => ({
      apis: {
        AssetConversionApi: {
          quote_price_tokens_for_exact_tokens: async (_a: unknown, _b: unknown, fee: bigint) =>
            fee / 1_000n,
        },
      },
      tx: {
        Assets: { transfer_keep_alive: () => ({ getEstimatedFees: async () => 160_000_000n }) },
        Psm: { redeem: () => ({ getEstimatedFees: async () => 40_000_000n }) },
      },
      query: {
        Assets: { Asset: { getValue: async () => ({ min_balance: 70_000n }) } },
        Psm: { Psm: { getValue: async () => ({ min_swap_amount: 1_000_000n }) } },
      },
    }),
  }),
}));
/** The PSM serves the sale at a 0.1% fee, with `reserved` of its room spoken for. */
const psm = vi.hoisted(() => ({ reserved: [] as bigint[] }));
vi.mock("@getsome/funding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@getsome/funding")>()),
  chooseCashTransfer: async () => "teleport",
  chooseRoute: async (_api: unknown, args: { reserved: bigint }) => {
    psm.reserved.push(args.reserved);
    return { tier: "psm", external: "USDT", feeRate: 1_000 };
  },
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
const RESERVED = 50_000_000n;
/** Of the 99.55 CASH that reaches the key, the redeem's 0.04 CASH fee with its tenth of margin
 *  and the 0.07 CASH min_balance stay behind; the rest redeems at 0.1%. */
const LANDED = psmRedeemOut(99_550_000n - 44_000n - 70_000n, 1_000);
/** Less the key's 0.16 USDT fee with its quarter of headroom and the 0.07 USDT minimum balance. */
const USDT_IN = LANDED - 200_000n - 70_000n;

describe("a sale through an offramp lane", () => {
  beforeEach(() => {
    cf.rate = 993_000n;
    cf.egressFee = 0n;
    cf.channelsOpen = true;
    cf.quoted.length = 0;
    cf.opened.length = 0;
    psm.reserved.length = 0;
  });

  it("quotes the swap on the least USDT the key lands and promises its floor", async () => {
    const size = await sizeSwapSale(AMOUNT, lane, RESERVED);
    expect(size.route).toEqual({ tier: "psm", external: "USDT", feeRate: 1_000 });
    // Decided with this app's other redeems ahead spoken for.
    expect(psm.reserved).toEqual([RESERVED]);
    expect(size.landing).toBe(LANDED);
    expect(size.usdtIn).toBe(USDT_IN);
    expect(cf.quoted).toEqual([USDT_IN.toString()]);
    const floor = (((USDT_IN * 993_000n) / 1_000_000n) * 9_950n) / 10_000n;
    // Cut to the four decimals a sale commits.
    expect(size.commit).toBe((floor / 100n) * 100n);
    // What the provider is promised keeps 1% under that for the seller's KYC.
    expect(size.promise).toBe(((size.commit * 9_900n) / 10_000n / 100n) * 100n);
  });

  it("opens the swap to the provider's address with the promise's slippage", async () => {
    const { promise } = await sizeSwapSale(AMOUNT, lane, RESERVED);
    const channel = await openSwapSaleChannel({
      amount: AMOUNT,
      lane,
      committed: promise,
      providerAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      keyPublicKeyHex: `0x${"07".repeat(32)}`,
      reserved: RESERVED,
    });
    // The least the key must land: what the swap is quoted on and the sweep's own cost.
    expect(channel).toMatchObject({
      id: "cf-7",
      address: "15ChannelOnAssetHub",
      amount: LANDED.toString(),
    });
    expect(cf.opened[0]).toMatchObject({
      destAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      fillOrKillParams: { slippageTolerancePercent: "0.5", retryDurationMinutes: 30 },
    });
  });

  it("still opens after the quote slipped while the seller verified, within the KYC margin", async () => {
    const { promise } = await sizeSwapSale(AMOUNT, lane, RESERVED);
    cf.rate = 988_000n; // half a percent worse than at confirm
    const channel = await openSwapSaleChannel({
      amount: AMOUNT,
      lane,
      committed: promise,
      providerAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      keyPublicKeyHex: `0x${"07".repeat(32)}`,
      reserved: RESERVED,
    });
    expect(channel).not.toBeNull();
  });

  it("opens nothing once today's floor no longer covers the promise", async () => {
    const { promise } = await sizeSwapSale(AMOUNT, lane, RESERVED);
    cf.rate = 980_000n;
    const channel = await openSwapSaleChannel({
      amount: AMOUNT,
      lane,
      committed: promise,
      providerAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      keyPublicKeyHex: `0x${"07".repeat(32)}`,
      reserved: RESERVED,
    });
    expect(channel).toBeNull();
    expect(cf.opened).toEqual([]);
  });

  it("refuses to size a lane sale whose channel this build cannot open, before any quote", async () => {
    cf.channelsOpen = false;
    await expect(sizeSwapSale(AMOUNT, lane, RESERVED)).rejects.toThrow(
      "Swap channels cannot be opened",
    );
    expect(cf.quoted).toEqual([]);
  });

  it("keeps the lane's delivery-fee headroom out of the promise", async () => {
    cf.egressFee = 25_000n; // 0.025 USDC on Arbitrum, kept three times over
    const arbitrum = laneById("usdc-arbitrum");
    const { commit } = await sizeSwapSale(AMOUNT, arbitrum, RESERVED);
    const kept = (USDT_IN * 993_000n) / 1_000_000n - 2n * 25_000n;
    expect(commit).toBe(((kept * 9_950n) / 10_000n / 100n) * 100n);
  });
});
