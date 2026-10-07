// The outgoing channel over a scripted SDK: the forward quote for what will land, and the channel
// opened with the key as refund and the user's address as destination.

import { describe, expect, it } from "vitest";
import type { SwapSdkLike } from "./sdk";
import { ASSET_HUB_USDT } from "./sources";
import { openWithdrawChannel, quoteOutgoing } from "./withdraw-channel";

const KEY_ON_ASSET_HUB = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
const BTC_ADDRESS = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const FOUR_DOT = 40_000_000_000n;

const REGULAR = {
  type: "REGULAR",
  egressAmount: "123456",
  recommendedSlippageTolerancePercent: "1.5",
  estimatedDurationSeconds: 900,
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
});
