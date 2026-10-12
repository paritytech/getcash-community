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

/** One fee the quote already subtracted, in the asset it is charged in. */
export interface IncludedFee {
  /** Chainflip's fee kind: INGRESS, NETWORK, EGRESS, BROKER or BOOST. */
  type: string;
  chain: string;
  asset: string;
  amount: bigint;
}

/** What a forward quote says about selling `amount` of DOT for the destination asset. */
export interface OutgoingQuote {
  /** The quote as Chainflip returned it; what the channel is opened with. */
  raw: Record<string, unknown>;
  /** What lands on the destination, in the destination asset's base units. */
  egressAmount: bigint;
  /** Chainflip's own estimate of the swap, seconds; null when absent. */
  estimatedDurationSeconds: number | null;
  /** The fees the egress already paid, each in its own asset; empty when the quote named none. */
  includedFees: IncludedFee[];
  /** The DOT the quote was asked for, base units. */
  depositAmount: bigint;
  /** The USDC leg of a two-leg swap, base units; null when the swap is one leg. */
  intermediateAmount: bigint | null;
}

/** The destination as Chainflip names it. */
export interface OutgoingDestination {
  chain: string;
  asset: string;
}

const numberOrNull = (value: unknown): number | null => (typeof value === "number" ? value : null);

const bigintOrNull = (value: unknown): bigint | null => {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint")
    return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
};

/** The quote's fee list, dropping any entry too malformed to price. */
function parseIncludedFees(value: unknown): IncludedFee[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { type, chain, asset, amount } = entry as Record<string, unknown>;
    const parsed = bigintOrNull(amount);
    if (typeof type !== "string" || typeof chain !== "string" || typeof asset !== "string")
      return [];
    return parsed === null ? [] : [{ type, chain, asset, amount: parsed }];
  });
}

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
    includedFees: parseIncludedFees(raw["includedFees"]),
    depositAmount: bigintOrNull(raw["depositAmount"]) ?? amount,
    intermediateAmount: bigintOrNull(raw["intermediateAmount"]),
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
