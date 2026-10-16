// The outgoing channel over a scripted SDK: the forward quote for what will land, and the channel
// opened with the key as refund and the user's address as destination.

import { describe, expect, it } from "vitest";
import type { SwapSdkLike } from "./sdk";
import { ASSET_HUB_USDT } from "./sources";
import {
  DEFAULT_CHANNEL_LIFETIME_MS,
  openWithdrawChannel,
  quoteOutgoing,
} from "./withdraw-channel";

const KEY_ON_ASSET_HUB = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
const BTC_ADDRESS = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const FOUR_DOT = 40_000_000_000n;
const TWENTY_USDT = 20_000_000n;

const REGULAR = {
  type: "REGULAR",
  egressAmount: "123456",
  recommendedSlippageTolerancePercent: "1.5",
  estimatedDurationSeconds: 900,
  depositAmount: "40000000000",
  intermediateAmount: "5000000",
  includedFees: [
    { chain: "Assethub", asset: "DOT", amount: "20000000", type: "INGRESS" },
    { chain: "Ethereum", asset: "USDC", amount: "5000", type: "NETWORK" },
    { chain: "Bitcoin", asset: "BTC", amount: "100", type: "EGRESS" },
    { chain: "Bitcoin", asset: "BTC", amount: "oops", type: "MALFORMED" },
  ],
};

/** An SDK that records what it was asked and answers from fixed replies. */
function scripted(quotes: unknown[] = [{ type: "DCA" }, REGULAR]) {
  const asked: { quote?: unknown; channel?: unknown } = {};
  const sdk: SwapSdkLike = {
    getQuoteV2: async (args) => {
      asked.quote = args;
      return { quotes };
    },
    requestDepositAddressV2: async (args) => {
      asked.channel = args;
      return {
        depositAddress: "5ChannelOnAssetHub",
        depositChannelId: "42",
        amount: "40000000000",
        estimatedDepositChannelExpiryTime: 1_800_000_000_000,
      };
    },
    getStatusV2: async () => ({}),
    getSwapLimits: async () => ({ minimumSwapAmounts: {} }),
  };
  return { sdk, asked };
}

const destination = { chain: "Bitcoin", asset: "BTC", address: BTC_ADDRESS };

describe("the outgoing channel", () => {
  it("quotes forwards, DOT on Asset Hub into the destination asset", async () => {
    const { sdk, asked } = scripted();
    const quote = await quoteOutgoing(sdk, FOUR_DOT, destination);
    expect(asked.quote).toEqual({
      srcChain: "Assethub",
      srcAsset: "DOT",
      destChain: "Bitcoin",
      destAsset: "BTC",
      amount: "40000000000",
    });
    expect(quote.egressAmount).toBe(123_456n);
    expect(quote.estimatedDurationSeconds).toBe(900);
    expect(quote.raw).toBe(REGULAR); // the regular quote, not the DCA one
    expect(quote.depositAmount).toBe(40_000_000_000n);
    expect(quote.intermediateAmount).toBe(5_000_000n);
    // The malformed entry is dropped; the priced ones come through in their own assets.
    expect(quote.includedFees).toEqual([
      { chain: "Assethub", asset: "DOT", amount: 20_000_000n, type: "INGRESS" },
      { chain: "Ethereum", asset: "USDC", amount: 5_000n, type: "NETWORK" },
      { chain: "Bitcoin", asset: "BTC", amount: 100n, type: "EGRESS" },
    ]);
  });

  it("quotes USDT on Asset Hub when the withdrawal lands that on its key", async () => {
    const { sdk, asked } = scripted();
    const quote = await quoteOutgoing(sdk, TWENTY_USDT, destination, ASSET_HUB_USDT);
    expect(asked.quote).toEqual({
      srcChain: "Assethub",
      srcAsset: "USDT",
      destChain: "Bitcoin",
      destAsset: "BTC",
      amount: "20000000",
    });
    expect(quote.egressAmount).toBe(123_456n);
  });

  it("opens a USDT-sourced channel with a quote for USDT", async () => {
    const { sdk, asked } = scripted();
    const channel = await openWithdrawChannel({
      sdk,
      amount: TWENTY_USDT,
      source: ASSET_HUB_USDT,
      destination,
      refundAddress: KEY_ON_ASSET_HUB,
    });
    expect(asked.quote).toMatchObject({ srcAsset: "USDT", amount: "20000000" });
    expect(asked.channel).toMatchObject({ quote: REGULAR, destAddress: BTC_ADDRESS });
    expect(channel.id).toBe("42");
  });

  it("opens the channel with that quote, refunding to the key, paying the user", async () => {
    const { sdk, asked } = scripted();
    const channel = await openWithdrawChannel({
      sdk,
      amount: FOUR_DOT,
      destination,
      refundAddress: KEY_ON_ASSET_HUB,
    });
    expect(channel).toEqual({
      id: "42",
      address: "5ChannelOnAssetHub",
      expiresAt: 1_800_000_000_000,
      expectedEgress: 123_456n,
    });
    expect(asked.channel).toEqual({
      quote: REGULAR,
      destAddress: BTC_ADDRESS,
      fillOrKillParams: {
        refundAddress: KEY_ON_ASSET_HUB,
        slippageTolerancePercent: "1.5",
        retryDurationMinutes: 10,
      },
    });
  });

  it("takes a channel the SDK names no expiry for as a day from now", async () => {
    // The broker path returns no expiry time. The worker holds the channel to this figure, which
    // stays short of the 26 hours Chainflip gives an Asset Hub channel today.
    const { sdk } = scripted();
    const broker: SwapSdkLike = {
      ...sdk,
      requestDepositAddressV2: async () => ({ depositAddress: "5Channel", depositChannelId: "42" }),
    };
    const before = Date.now();
    const channel = await openWithdrawChannel({
      sdk: broker,
      amount: FOUR_DOT,
      destination,
      refundAddress: KEY_ON_ASSET_HUB,
    });
    expect(channel.expiresAt).toBeGreaterThanOrEqual(before + DEFAULT_CHANNEL_LIFETIME_MS);
    expect(channel.expiresAt).toBeLessThanOrEqual(Date.now() + DEFAULT_CHANNEL_LIFETIME_MS);
    expect(DEFAULT_CHANNEL_LIFETIME_MS).toBe(24 * 3_600_000);
  });

  it("refuses nothing to sell and a pair Chainflip cannot quote", async () => {
    await expect(
      openWithdrawChannel({
        sdk: scripted().sdk,
        amount: 0n,
        destination,
        refundAddress: KEY_ON_ASSET_HUB,
      }),
    ).rejects.toThrow("nothing to quote");
    await expect(
      openWithdrawChannel({
        sdk: scripted([]).sdk,
        amount: FOUR_DOT,
        destination,
        refundAddress: KEY_ON_ASSET_HUB,
      }),
    ).rejects.toThrow(/no BTC quote/);
  });

  it("sells Asset Hub USDT to a lane key at the slippage the sale committed to", async () => {
    const { sdk, asked } = scripted();
    const solanaKey = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    await openWithdrawChannel({
      sdk,
      source: ASSET_HUB_USDT,
      amount: 99_900_000n,
      destination: { chain: "Solana", asset: "USDT", address: solanaKey },
      refundAddress: KEY_ON_ASSET_HUB,
      fillOrKill: { slippageTolerancePercent: "0.3", retryDurationMinutes: 30 },
    });
    expect(asked.quote).toEqual({
      srcChain: "Assethub",
      srcAsset: "USDT",
      destChain: "Solana",
      destAsset: "USDT",
      amount: "99900000",
    });
    expect(asked.channel).toEqual({
      quote: REGULAR,
      destAddress: solanaKey,
      fillOrKillParams: {
        refundAddress: KEY_ON_ASSET_HUB,
        slippageTolerancePercent: "0.3",
        retryDurationMinutes: 30,
      },
    });
  });

  it("names the source asset when Chainflip cannot quote it", async () => {
    await expect(
      quoteOutgoing(scripted([]).sdk, 1n, { chain: "Solana", asset: "USDT" }, ASSET_HUB_USDT),
    ).rejects.toThrow(/no USDT quote for 1 USDT/);
  });

  it("reads the destination's delivery fee off the quote, or 0 when it is not itemised", async () => {
    const withFee = {
      ...REGULAR,
      includedFees: [
        { type: "NETWORK", amount: "248995" },
        { type: "EGRESS", amount: "25124" },
      ],
    };
    expect((await quoteOutgoing(scripted([withFee]).sdk, 1n, destination)).egressFee).toBe(25_124n);
    const unitemised = { ...REGULAR, includedFees: [] };
    expect((await quoteOutgoing(scripted([unitemised]).sdk, 1n, destination)).egressFee).toBe(0n);
    const garbled = { ...REGULAR, includedFees: [{ type: "EGRESS", amount: "n/a" }] };
    expect((await quoteOutgoing(scripted([garbled]).sdk, 1n, destination)).egressFee).toBe(0n);
  });
});
