// Sizing a lane sale over a scripted PSM and Chainflip, at the quote's floor while it covers.

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
  ccm: [] as unknown[],
  opened: [] as unknown[],
  channelsOpen: true,
}));
vi.mock("../lib/chainflip-backend", () => {
  const sdk = {
    getQuoteV2: async (args: { amount: string; ccmParams?: unknown }) => {
      cf.quoted.push(args.amount);
      cf.ccm.push(args.ccmParams);
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
      return {
        depositAddress: "15ChannelOnAssetHub",
        depositChannelId: "cf-7",
        depositChannelExpiryBlock: 4_162_149n,
      };
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

import {
  chainflipRpcUrl,
  encodeSaleMessage,
  predictSaleVaultProxy,
  SALE_VAULT_PROXY_CCM_GAS_BUDGET,
} from "@getsome/chainflip";
import { laneById } from "@getsome/offramp";
import { psmRedeemOut } from "@getsome/withdraw";
import { SALE_SWAP_NETWORK } from "../lib/config";
import { openSwapSaleChannel, sizeSwapSale } from "../lib/withdraw-live";

const lane = laneById("usdc-arbitrum");
const FACTORY = `0x${"11".repeat(20)}`;
const IMPLEMENTATION = `0x${"22".repeat(20)}`;
const KEY_HEX = `0x${"07".repeat(32)}`;
const CLAIMER = `0x${"55".repeat(20)}`;
const PROXY = predictSaleVaultProxy(FACTORY, IMPLEMENTATION, KEY_HEX, CLAIMER);
const PROVIDER = `0x${"33".repeat(20)}`;
const AMOUNT = 100_000_000n;
const RESERVED = 50_000_000n;
/** Of the 99.55 CASH that reaches the key, the redeem's 0.04 CASH fee with its tenth of margin
 *  and the 0.07 CASH min_balance stay behind; the rest redeems at 0.1%. */
const LANDED = psmRedeemOut(99_550_000n - 44_000n - 70_000n, 1_000);
/** Less the key's 0.16 USDT fee with its quarter of headroom and the 0.07 USDT minimum balance. */
const USDT_IN = LANDED - 200_000n - 70_000n;
/** The sale's payment deadline on record, half a second past a whole second. */
const PAYMENT_EXPIRES_AT = 1_798_761_600_500;
/** Chainflip's clock at the timing, Asset Hub 600 blocks short of expiry at 12 s a block. */
const CF_NOW = 1_793_007_348_000;
// Chainflip's best block, above the pace window so a window-earlier block exists
const CF_BEST = "0x400";
const u64 = (n: number) =>
  `0x${BigInt(n).toString(16).padStart(16, "0").match(/../g)!.reverse().join("")}`;
const stateChain = async (_url: unknown, init: { body: string }) => {
  const { method, params } = JSON.parse(init.body) as { method: string; params: unknown[] };
  const back = params.at(-1) === CF_BEST ? 0 : 1;
  const result =
    method === "chain_getHeader"
      ? { number: CF_BEST }
      : method === "chain_getBlockHash"
        ? `0x${Number(params[0]).toString(16)}`
        : method === "cf_monitoring_external_chains_block_height"
          ? { assethub: 4_161_549 - back * 600 }
          : u64(CF_NOW - back * 7_200_000);
  return { ok: true, status: 200, json: async () => ({ result }) };
};

describe("a sale through an offramp lane", () => {
  beforeEach(() => {
    cf.rate = 993_000n;
    cf.egressFee = 0n;
    cf.channelsOpen = true;
    cf.quoted.length = 0;
    cf.ccm.length = 0;
    cf.opened.length = 0;
    psm.reserved.length = 0;
    vi.stubGlobal("fetch", vi.fn(stateChain));
  });

  /** Opens the sale's channel with `over` in place of the defaults. */
  const open = (committed: bigint, over: Record<string, unknown> = {}) =>
    openSwapSaleChannel({
      amount: AMOUNT,
      lane,
      committed,
      providerAddress: PROVIDER,
      keyPublicKeyHex: KEY_HEX,
      fundingRequestId: "funding-1",
      walletAddress: PROXY.toLowerCase(),
      reserved: RESERVED,
      paymentExpiresAt: PAYMENT_EXPIRES_AT,
      claimerAddress: CLAIMER,
      deployment: { chainId: 42161, factory: FACTORY, implementation: IMPLEMENTATION },
      ...over,
    });

  it("quotes the swap on the least USDT the key lands and promises its floor", async () => {
    const size = await sizeSwapSale(AMOUNT, lane, RESERVED);
    expect(size.route).toEqual({ tier: "psm", external: "USDT", feeRate: 1_000 });
    // Decided with this app's other redeems ahead spoken for.
    expect(psm.reserved).toEqual([RESERVED]);
    expect(size.landing).toBe(LANDED);
    expect(size.usdtIn).toBe(USDT_IN);
    expect(cf.quoted).toEqual([USDT_IN.toString()]);
    // The proxy delivery's gas and the 192-byte message are priced into the quote
    expect(cf.ccm).toEqual([
      { gasBudget: SALE_VAULT_PROXY_CCM_GAS_BUDGET, messageLengthBytes: 192 },
    ]);
    const floor = (((USDT_IN * 993_000n) / 1_000_000n) * 9_950n) / 10_000n;
    // Cut to the four decimals a sale commits.
    expect(size.commit).toBe((floor / 100n) * 100n);
    // What the provider is promised keeps 1% under that for the seller's KYC.
    expect(size.promise).toBe(((size.commit * 9_900n) / 10_000n / 100n) * 100n);
  });

  it("opens the swap to the factory with the sale's CCM message and the promise's slippage", async () => {
    const { promise } = await sizeSwapSale(AMOUNT, lane, RESERVED);
    const channel = await open(promise);
    // The least the key must land: what the swap is quoted on and the sweep's own cost.
    expect(channel).toMatchObject({
      id: "cf-7",
      address: "15ChannelOnAssetHub",
      // Closes at its expiry block as Chainflip tracks Asset Hub: 600 blocks at 12 s
      expiresAt: CF_NOW + 600 * 12_000,
      amount: LANDED.toString(),
      proxyChainId: 42161,
      proxyFactory: FACTORY,
      proxyImplementation: IMPLEMENTATION,
      proxyAddress: PROXY,
      claimerAddress: CLAIMER,
      paymentExpiresAt: PAYMENT_EXPIRES_AT,
    });
    // The expiry is timed on the state chain of the network the sale SDK opened on
    expect(new Set(vi.mocked(fetch).mock.calls.map(([url]) => url))).toEqual(
      new Set([chainflipRpcUrl(SALE_SWAP_NETWORK)]),
    );
    expect(cf.opened[0]).toMatchObject({
      destAddress: FACTORY,
      fillOrKillParams: { slippageTolerancePercent: "0.5", retryDurationMinutes: 30 },
      ccmParams: {
        message: encodeSaleMessage({
          fundingRequestId: "funding-1",
          recipient: PROVIDER,
          committed: promise,
          home: KEY_HEX,
          paymentExpiresAt: PAYMENT_EXPIRES_AT,
          claimer: CLAIMER,
        }),
      },
    });
  });

  it("refuses a deployment other than the one the proxy was derived for, before any quote", async () => {
    const deployment = {
      chainId: 42161,
      factory: `0x${"77".repeat(20)}`,
      implementation: IMPLEMENTATION,
    };
    await expect(open(1_000_000n, { deployment })).rejects.toThrow(
      "sending address does not match",
    );
    expect(cf.quoted).toEqual([]);
    expect(cf.opened).toEqual([]);
  });

  it("refuses a sending address other than the key's proxy", async () => {
    await expect(open(1_000_000n, { walletAddress: `0x${"44".repeat(20)}` })).rejects.toThrow(
      "sending address does not match",
    );
    expect(cf.opened).toEqual([]);
  });

  it("refuses a claimer other than the one the proxy was derived for", async () => {
    await expect(open(1_000_000n, { claimerAddress: `0x${"66".repeat(20)}` })).rejects.toThrow(
      "sending address does not match",
    );
    expect(cf.opened).toEqual([]);
  });

  it("refuses a Solana lane, which has no sending address this app controls", async () => {
    await expect(open(1_000_000n, { lane: laneById("usdt-solana") })).rejects.toThrow(
      "no sending address",
    );
    expect(cf.opened).toEqual([]);
  });

  it("refuses a provider deposit that is not an EVM address", async () => {
    await expect(
      open(1_000_000n, { providerAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" }),
    ).rejects.toThrow("not an Arbitrum address");
    expect(cf.opened).toEqual([]);
  });

  it("still opens after the quote slipped while the seller verified, within the KYC margin", async () => {
    const { promise } = await sizeSwapSale(AMOUNT, lane, RESERVED);
    cf.rate = 988_000n; // half a percent worse than at confirm
    const channel = await open(promise);
    expect(channel).not.toBeNull();
  });

  it("opens nothing once today's floor no longer covers the promise", async () => {
    const { promise } = await sizeSwapSale(AMOUNT, lane, RESERVED);
    cf.rate = 980_000n;
    const channel = await open(promise);
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
    const { commit } = await sizeSwapSale(AMOUNT, lane, RESERVED);
    const kept = (USDT_IN * 993_000n) / 1_000_000n - 2n * 25_000n;
    expect(commit).toBe(((kept * 9_950n) / 10_000n / 100n) * 100n);
  });
});
