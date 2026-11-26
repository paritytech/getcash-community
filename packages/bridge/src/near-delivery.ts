// NEAR Intents as the provider that delivers the ETH of a top-up to the key. A dry quote says
// what the user pays for an exact amount of ETH. It opens no deposit address.

import {
  IntentsNoAnswer,
  IntentsRefused,
  type IntentsClient,
  type IntentsQuoteRequest,
} from "@getsome/intents";
import type { Delivery } from "./reads";

export interface NearDeliveryInput {
  near: Pick<IntentsClient, "quote">;
  /** What the user pays with, and the ETH of the chain where the route starts. */
  originAsset: string;
  destinationAsset: string;
  /** The address of the key. */
  recipient: string;
  /** Where NEAR returns what it does not swap. */
  refundTo: string;
  slippageBps: number;
  /** Until when NEAR waits for the deposit, in epoch ms. Read at each quote. */
  deadline(): number;
}

/** The provider of a route, over the NEAR client. */
export function nearDelivery(input: NearDeliveryInput): Delivery {
  return async (wei) => {
    const request: IntentsQuoteRequest = {
      exact: "output",
      amount: wei,
      originAsset: input.originAsset,
      destinationAsset: input.destinationAsset,
      recipient: input.recipient,
      refundTo: input.refundTo,
      slippageBps: input.slippageBps,
      deadline: input.deadline(),
    };
    try {
      const quote = await input.near.quote(request);
      // An exact output must give the key all it asked for.
      if (quote.minAmountOut < wei) {
        return { kind: "no-answer", reason: "the quote delivers less than was asked" };
      }
      return { kind: "open", pays: quote.amountIn, paysLeast: quote.minAmountIn };
    } catch (error) {
      if (error instanceof IntentsNoAnswer) return { kind: "no-answer", reason: error.message };
      if (!(error instanceof IntentsRefused)) throw error;
      const { refusal } = error;
      if (refusal.kind !== "too-small") return { kind: "closed", reason: error.message };
      return {
        kind: "too-small",
        ...(refusal.minimum === undefined ? {} : { minimumWei: refusal.minimum }),
        ...(refusal.minimumUsd === undefined ? {} : { minimumUsd: refusal.minimumUsd }),
      };
    }
  };
}
