// Opens a Meld pay session bound to the burner and maps it to a core DepositChannel.
// The burner is the deposit address; the buyer pays through the hosted pay page.

import type { DepositChannel, OpenChannelArgs } from "@getsome/core";
import type { MeldClientLike } from "./client";
import type { MeldQuoteRaw } from "./quote";

/** Fallback resume window for a Meld purchase when Meld published no expiry. */
const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A Meld deposit channel plus the hosted pay URL. */
export interface MeldDepositChannel {
  readonly channel: DepositChannel;
  readonly widgetUrl: string;
}

/**
 * Opens a Meld session for the quoted provider with the burner as the delivery wallet. Returns a
 * DepositChannel whose address is the burner and whose id is the adapter's funding-request id,
 * plus the hosted pay URL.
 */
export async function requestMeldDeposit(
  client: MeldClientLike,
  args: OpenChannelArgs,
): Promise<MeldDepositChannel> {
  const raw = args.quote.raw as MeldQuoteRaw | undefined;
  if (!raw?.provider || !raw.context) {
    throw new Error("Meld deposit needs a Meld quote (missing raw provider/context)");
  }
  const { provider, context } = raw;

  const session = await client.createSession({
    serviceProvider: provider.serviceProvider,
    country: context.country,
    sourceCurrencyCode: context.fiat,
    sourceAmount: provider.sourceAmount,
    destinationCurrencyCode: context.token,
    destinationAmount: provider.destinationAmount,
    walletAddress: args.destAddress,
    paymentMethodType: context.method,
  });

  // Prefer Meld's own hosted widget; fall back to the raw provider page.
  const embedUrl = session.meldWidgetUrl ?? session.widgetUrl;

  return {
    channel: {
      // The adapter's funding-request id, which status polling and resume use.
      depositChannelId: session.fundingRequestId,
      deposit: {
        address: args.destAddress,
        amount: args.quote.source.amount,
        formatted: args.quote.source.formatted,
        assetSymbol: args.quote.source.assetSymbol,
        // Falls back to the resume window so core can re-attach the channel after a reload.
        expiresAt: session.expiresAt ?? Date.now() + RESUME_WINDOW_MS,
        // The hosted pay page: the deposit screen opens this in a WebView for the fiat rail.
        payUrl: embedUrl,
      },
    },
    widgetUrl: embedUrl,
  };
}
