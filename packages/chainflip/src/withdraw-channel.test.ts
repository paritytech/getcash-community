// The outgoing channel over a scripted SDK: the forward quote for what will land, and the channel
// opened with the key as refund and the user's address as destination.

import { describe, expect, it } from "vitest";
import type { SwapSdkLike } from "./sdk";
import { openWithdrawChannel, quoteOutgoing } from "./withdraw-channel";

const KEY_ON_ASSET_HUB = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
const BTC_ADDRESS = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const FOUR_DOT = 40_000_000_000n;

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
});
