// Deposit-channel opening over the Chainflip SDK.

import type { DepositChannel, OpenChannelArgs } from "@getsome/core";
import type { RequestDepositAddressV2Args } from "./sdk";
import { formatSourceAmount, type SourceConfig } from "./sources";

export interface DepositBackend {
  requestDepositAddressV2(args: RequestDepositAddressV2Args): Promise<unknown>;
}

export async function requestDepositAddress(
  backend: DepositBackend,
  source: SourceConfig,
  args: OpenChannelArgs,
): Promise<DepositChannel> {
  if (!args.refundAddress) {
    throw new Error(`${source.shortName} refund address is required`);
  }
  const rawQuote = args.quote.raw as Record<string, unknown>;

  let result: unknown;
  try {
    result = await backend.requestDepositAddressV2({
      quote: rawQuote,
      destAddress: args.destAddress,
      fillOrKillParams: {
        refundAddress: args.refundAddress,
        slippageTolerancePercent:
          (rawQuote?.["recommendedSlippageTolerancePercent"] as string | undefined) ?? "3",
        retryDurationMinutes: 10,
      },
    });
  } catch (err) {
    throw new Error("Failed to open swap deposit channel", { cause: err });
  }

  const typed = result as {
    depositAddress: string;
    depositChannelId: string;
    amount?: string;
    estimatedDepositChannelExpiryTime?: number;
  };

  // The channel echoes the ingress amount; fall back to the quote's if the SDK omits it.
  const amount = typed.amount ? BigInt(typed.amount) : args.quote.source.amount;

  return {
    depositChannelId: typed.depositChannelId,
    deposit: {
      address: typed.depositAddress,
      amount,
      // Ceil-rounded like the quote.
      formatted: formatSourceAmount(source, amount),
      assetSymbol: source.shortName,
      // estimatedDepositChannelExpiryTime is in milliseconds; 0 = SDK gave none.
      expiresAt: typed.estimatedDepositChannelExpiryTime ?? 0,
    },
  };
}
