// The outgoing channel: an Asset Hub asset (DOT by default, USDT for an offramp sale) sold for a
// destination asset and paid out to the given address. The mirror of the deposit rail, which quotes backwards from a wanted DOT amount and
// opens channels that end on Asset Hub. This quotes forwards from the DOT a withdrawal expects to
// land and opens the channel with the withdrawal's own key as the refund address.
//
// Opened on the page, at confirm, while the user is there: the quote they were shown is the
// quote the channel is opened with. The worker then only pays the channel and reads the swap.

import type { OpenChannelArgs, Quote } from "@getsome/core";
import { requestDepositAddress } from "./deposit";
import { pickRegularQuote, type QuoteBackend } from "./quote";
import type { SwapSdkLike } from "./sdk";
import { ASSET_HUB_DOT, formatSourceAmount, type SourceConfig } from "./sources";

/** What a forward quote says about selling `amount` of the source for the destination asset. */
export interface OutgoingQuote {
  /** The quote as Chainflip returned it; what the channel is opened with. */
  raw: Record<string, unknown>;
  /** What lands on the destination, in the destination asset's base units. */
  egressAmount: bigint;
  /** Chainflip's own estimate of the swap, seconds; null when absent. */
  estimatedDurationSeconds: number | null;
}

/** The destination as Chainflip names it. */
export interface OutgoingDestination {
  chain: string;
  asset: string;
}

const numberOrNull = (value: unknown): number | null => (typeof value === "number" ? value : null);

/** Quotes selling `amount` of `source` (DOT on Asset Hub unless named) for the destination asset.
 *  Throws when Chainflip has no quote for the pair. */
export async function quoteOutgoing(
  backend: QuoteBackend,
  amount: bigint,
  destination: OutgoingDestination,
  source: SourceConfig = ASSET_HUB_DOT,
): Promise<OutgoingQuote> {
  const { quotes } = await backend.getQuoteV2({
    srcChain: source.chain,
    srcAsset: source.asset,
    destChain: destination.chain,
    destAsset: destination.asset,
    amount: amount.toString(),
  });
  const raw = pickRegularQuote(quotes);
  if (raw === null) {
    throw new Error(
      `Chainflip has no ${destination.asset} quote for ${amount} ${source.asset} on Asset Hub`,
    );
  }
  return {
    raw,
    egressAmount: BigInt(String(raw["egressAmount"] ?? "0")),
    estimatedDurationSeconds: numberOrNull(raw["estimatedDurationSeconds"]),
  };
}

export interface OpenWithdrawChannelArgs {
  sdk: SwapSdkLike;
  /** What is sold. DOT on Asset Hub unless named. */
  source?: SourceConfig;
  /** The source the withdrawal expects to land on its key, base units: what the quote is for. The
   *  channel takes whatever then arrives; the quote sets the price it must fill at. */
  amount: bigint;
  destination: OutgoingDestination & { address: string };
  /** Where the swap refunds when it cannot fill at the quoted price: the key on Asset Hub, SS58. */
  refundAddress: string;
  /** Fill-or-kill terms; the quote's recommended slippage when absent. */
  fillOrKill?: OpenChannelArgs["fillOrKill"];
}

/** The channel a withdrawal pays: its id, the Asset Hub account, and when Chainflip closes it. */
export interface WithdrawChannel {
  id: string;
  address: string;
  /** ms since the epoch; 0 when Chainflip gave none. */
  expiresAt: number;
  /** What the quote said would land, in the destination asset's base units. */
  expectedEgress: bigint;
}

/** Quotes and opens the channel in one go, so the two can never disagree. */
export async function openWithdrawChannel(args: OpenWithdrawChannelArgs): Promise<WithdrawChannel> {
  if (args.amount <= 0n) throw new Error("nothing to quote a swap for");
  const source = args.source ?? ASSET_HUB_DOT;
  const quoted = await quoteOutgoing(args.sdk, args.amount, args.destination, source);
  const quote: Quote = {
    sourceId: source.sourceId,
    source: {
      amount: args.amount,
      formatted: formatSourceAmount(source, args.amount),
      assetSymbol: source.shortName,
      decimals: source.decimals,
    },
    raw: quoted.raw,
  };
  const channel = await requestDepositAddress(args.sdk, source, {
    quote,
    destAddress: args.destination.address,
    refundAddress: args.refundAddress,
    ...(args.fillOrKill ? { fillOrKill: args.fillOrKill } : {}),
  });
  return {
    id: channel.depositChannelId,
    address: channel.deposit.address,
    expiresAt: channel.deposit.expiresAt,
    expectedEgress: quoted.egressAmount,
  };
}
