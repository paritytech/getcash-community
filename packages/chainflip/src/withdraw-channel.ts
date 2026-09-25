// The outgoing channel: DOT on Asset Hub sold for a destination asset and paid out to the user's
// address. The mirror of the deposit rail, which quotes backwards from a wanted DOT amount and
// opens channels that end on Asset Hub. This quotes forwards from the DOT a withdrawal expects to
// land and opens the channel with the withdrawal's own key as the refund address.
//
// Opened on the page, at confirm, while the user is there: the quote they were shown is the
// quote the channel is opened with. The worker then only pays the channel and reads the swap.

import type { Quote } from "@getsome/core";
import { requestDepositAddress } from "./deposit";
import { pickRegularQuote, type QuoteBackend } from "./quote";
import type { SwapSdkLike } from "./sdk";
import { ASSET_HUB_DOT, formatSourceAmount } from "./sources";

/** What a forward quote says about selling `amount` of DOT for the destination asset. */
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

/** Quotes selling `amount` of DOT on Asset Hub for the destination asset. Throws when Chainflip
 *  has no quote for the pair. */
export async function quoteOutgoing(
  backend: QuoteBackend,
  amount: bigint,
  destination: OutgoingDestination,
): Promise<OutgoingQuote> {
  const { quotes } = await backend.getQuoteV2({
    srcChain: ASSET_HUB_DOT.chain,
    srcAsset: ASSET_HUB_DOT.asset,
    destChain: destination.chain,
    destAsset: destination.asset,
    amount: amount.toString(),
  });
  const raw = pickRegularQuote(quotes);
  if (raw === null) {
    throw new Error(`Chainflip has no ${destination.asset} quote for ${amount} DOT on Asset Hub`);
  }
  return {
    raw,
    egressAmount: BigInt(String(raw["egressAmount"] ?? "0")),
    estimatedDurationSeconds: numberOrNull(raw["estimatedDurationSeconds"]),
  };
}

export interface OpenWithdrawChannelArgs {
  sdk: SwapSdkLike;
  /** The DOT the withdrawal expects to land on its key, base units: what the quote is for. The
   *  channel takes whatever then arrives; the quote sets the price it must fill at. */
  amount: bigint;
  destination: OutgoingDestination & { address: string };
  /** Where the swap refunds when it cannot fill at the quoted price: the key on Asset Hub, SS58. */
  refundAddress: string;
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
  const quoted = await quoteOutgoing(args.sdk, args.amount, args.destination);
  const quote: Quote = {
    sourceId: ASSET_HUB_DOT.sourceId,
    source: {
      amount: args.amount,
      formatted: formatSourceAmount(ASSET_HUB_DOT, args.amount),
      assetSymbol: ASSET_HUB_DOT.shortName,
      decimals: ASSET_HUB_DOT.decimals,
    },
    raw: quoted.raw,
  };
  const channel = await requestDepositAddress(args.sdk, ASSET_HUB_DOT, {
    quote,
    destAddress: args.destination.address,
    refundAddress: args.refundAddress,
  });
  return {
    id: channel.depositChannelId,
    address: channel.deposit.address,
    expiresAt: channel.deposit.expiresAt,
    expectedEgress: quoted.egressAmount,
  };
}
