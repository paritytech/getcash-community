// NEAR as the provider of a route, over a scripted client: the quote it asks for, and the answer
// each reply becomes.

import { IntentsNoAnswer, IntentsRefused, type IntentsQuote } from "@getsome/intents";
import { describe, expect, it } from "vitest";
import { nearDelivery } from "./near-delivery";

const WEI = 50_200_000_000_000_000n;
const QUOTE: IntentsQuote = {
  amountIn: 86_358_026n,
  minAmountIn: 85_494_445n,
  amountOut: WEI,
  minAmountOut: WEI,
  timeEstimate: 22,
};

function provider(reply: IntentsQuote | Error) {
  const asked: unknown[] = [];
  let clock = 1_000;
  const delivery = nearDelivery({
    near: {
      quote: async (request) => {
        asked.push(request);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
    originAsset: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    destinationAsset: "nep141:base.omft.near",
    recipient: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    refundTo: "13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK",
    slippageBps: 100,
    deadline: () => (clock += 1_000),
  });
  return { delivery, asked };
}

describe("nearDelivery", () => {
  it("asks for the exact amount of ETH on the key, and reads the deadline at each quote", async () => {
    const { delivery, asked } = provider(QUOTE);
    await delivery(WEI);
    await delivery(WEI + 1n);
    expect(asked).toEqual([
      {
        exact: "output",
        amount: WEI,
        originAsset: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
        destinationAsset: "nep141:base.omft.near",
        recipient: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        refundTo: "13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK",
        slippageBps: 100,
        deadline: 2_000,
      },
      expect.objectContaining({ amount: WEI + 1n, deadline: 3_000 }),
    ]);
  });

  it("gives what the user pays and the least NEAR keeps of it", async () => {
    const { delivery } = provider(QUOTE);
    expect(await delivery(WEI)).toEqual({
      kind: "open",
      pays: 86_358_026n,
      paysLeast: 85_494_445n,
    });
  });

  it("does not take a quote that can deliver less than was asked", async () => {
    const { delivery } = provider({ ...QUOTE, minAmountOut: WEI - 1n });
    expect(await delivery(WEI)).toEqual({
      kind: "no-answer",
      reason: "the quote delivers less than was asked",
    });
  });

  it.each<[string, string, unknown]>([
    [
      "a minimum in wei",
      "Amount is too low for bridge, try at least 110886749795838",
      { kind: "too-small", minimumWei: 110_886_749_795_838n },
    ],
    [
      "a minimum in dollars",
      "Temporary swap limits: minimum swap amount is $100",
      { kind: "too-small", minimumUsd: 100 },
    ],
    [
      "an amount no one offers to swap",
      "No liquidity available",
      { kind: "closed", reason: "No liquidity available" },
    ],
    [
      "an asset NEAR does not know",
      "tokenIn is not valid",
      { kind: "closed", reason: "tokenIn is not valid" },
    ],
    [
      "a text the client does not know",
      "Solver capacity reached",
      { kind: "closed", reason: "Solver capacity reached" },
    ],
  ])("reads NEAR's refusal for %s", async (_name, message, answer) => {
    const { delivery } = provider(new IntentsRefused(message));
    expect(await delivery(WEI)).toEqual(answer);
  });

  it("reads NEAR's silence as no answer", async () => {
    const { delivery } = provider(new IntentsNoAnswer("HTTP 503"));
    expect(await delivery(WEI)).toEqual({ kind: "no-answer", reason: "HTTP 503" });
  });

  it("passes on an error that is not NEAR's", async () => {
    const bug = new TypeError("not a function");
    const { delivery } = provider(bug);
    await expect(delivery(WEI)).rejects.toBe(bug);
  });
});
