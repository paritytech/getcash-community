// The outgoing channel: the token a withdrawal lands on Asset Hub, DOT or USDT, sold for a
// destination asset and paid out to the user's address. The mirror of the deposit rail, which
// quotes backwards from a wanted DOT amount and opens channels that end on Asset Hub. This quotes
// forwards from what a withdrawal expects to land and opens the channel with the withdrawal's own
// key as the refund address.
//
// Opened on the page, at confirm, while the user is there: the quote they were shown is the
// quote the channel is opened with. The worker then only pays the channel and reads the swap.

import type { OpenChannelArgs, Quote } from "@getsome/core";
import { chainPace, channelExpiresAt, chainflipRpc, type ChainflipRpc } from "./channel-expiry";
import { requestDepositAddress } from "./deposit";
import { pickRegularQuote, type QuoteBackend } from "./quote";
import type { ChainflipNetworkId, GetQuoteV2Args, SwapSdkLike } from "./sdk";
import { ASSET_HUB_DOT, formatSourceAmount, type SourceConfig } from "./sources";

/** One fee the quote already subtracted, in the asset it is charged in. */
export interface IncludedFee {
  /** Chainflip's fee kind: INGRESS, NETWORK, EGRESS, BROKER or BOOST. */
  type: string;
  chain: string;
  asset: string;
  amount: bigint;
}

/** What a forward quote says about selling `amount` of the source for the destination asset. */
export interface OutgoingQuote {
  /** The quote as Chainflip returned it; what the channel is opened with. */
  raw: Record<string, unknown>;
  /** What lands on the destination, in the destination asset's base units. */
  egressAmount: bigint;
  /** The destination chain's delivery fee inside that figure, same units; 0 when not itemised.
   *  It moves with the chain's gas between the quote and the delivery. */
  egressFee: bigint;
  /** Chainflip's own estimate of the swap, seconds; null when absent. */
  estimatedDurationSeconds: number | null;
  /** The fees the egress already paid, each in its own asset; empty when the quote named none. */
  includedFees: IncludedFee[];
  /** The source the quote was asked for, base units. */
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

/** The `EGRESS` line of a quote's `includedFees`, base units of the destination asset. */
function egressFeeOf(raw: Record<string, unknown>): bigint {
  const fees = Array.isArray(raw["includedFees"]) ? (raw["includedFees"] as unknown[]) : [];
  const egress = fees.find(
    (f): f is { amount: unknown } =>
      typeof f === "object" && f !== null && (f as { type?: unknown }).type === "EGRESS",
  );
  try {
    return egress === undefined ? 0n : BigInt(String(egress.amount));
  } catch {
    return 0n;
  }
}

/** Quotes selling `amount` of `source` (DOT on Asset Hub unless named) for the destination asset.
 *  Throws when Chainflip has no quote for the pair. */
export async function quoteOutgoing(
  backend: QuoteBackend,
  amount: bigint,
  destination: OutgoingDestination,
  source: SourceConfig = ASSET_HUB_DOT,
  ccmParams?: GetQuoteV2Args["ccmParams"],
): Promise<OutgoingQuote> {
  const { quotes } = await backend.getQuoteV2({
    srcChain: source.chain,
    srcAsset: source.asset,
    destChain: destination.chain,
    destAsset: destination.asset,
    amount: amount.toString(),
    // Priced in only for a CCM sale, so the quote covers the destination contract call
    ...(ccmParams ? { ccmParams } : {}),
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
    egressFee: egressFeeOf(raw),
    estimatedDurationSeconds: numberOrNull(raw["estimatedDurationSeconds"]),
    includedFees: parseIncludedFees(raw["includedFees"]),
    depositAmount: bigintOrNull(raw["depositAmount"]) ?? amount,
    intermediateAmount: bigintOrNull(raw["intermediateAmount"]),
  };
}

export interface OpenWithdrawChannelArgs {
  sdk: SwapSdkLike;
  /** The network `sdk` opens on, whose state chain times the channel's expiry. */
  network: ChainflipNetworkId;
  /** The state chain's RPC, the network's public one when absent. */
  rpc?: ChainflipRpc;
  /** The source the withdrawal expects to land on its key, base units: what the quote is for. The
   *  channel takes whatever then arrives; the quote sets the price it must fill at. */
  amount: bigint;
  /** The Asset Hub source the key pays the channel in; DOT when none is named. */
  source?: SourceConfig;
  destination: OutgoingDestination & { address: string };
  /** Where the swap refunds when it cannot fill at the quoted price: the key on Asset Hub, SS58. */
  refundAddress: string;
  /** Fill-or-kill terms; the quote's recommended slippage, half a point at least, when absent. */
  fillOrKill?: OpenChannelArgs["fillOrKill"];
  /** CCM terms when the channel pays a destination contract, as a SaleVaultProxy offramp sale does. */
  ccm?: OpenChannelArgs["ccm"];
}

/** The channel a withdrawal pays: its id, the Asset Hub account, and when Chainflip closes it. */
export interface WithdrawChannel {
  id: string;
  address: string;
  /** ms since the epoch: the channel's expiry block at the pace Chainflip tracks its chain. */
  expiresAt: number;
  /** What the quote said would land, in the destination asset's base units. */
  expectedEgress: bigint;
}

// The byte length of a 0x-hex CCM message, refusing anything that is not whole bytes
function ccmMessageBytes(message: string): number {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(message)) throw new Error("CCM message must be 0x-hex bytes");
  return (message.length - 2) / 2;
}

/** Quotes and opens the channel in one go, so the two can never disagree. */
export async function openWithdrawChannel(args: OpenWithdrawChannelArgs): Promise<WithdrawChannel> {
  if (args.amount <= 0n) throw new Error("nothing to quote a swap for");
  const source = args.source ?? ASSET_HUB_DOT;
  // A CCM sale prices the message into the quote, so the floor covers the destination contract call
  const quoteCcm = args.ccm
    ? { gasBudget: args.ccm.gasBudget, messageLengthBytes: ccmMessageBytes(args.ccm.message) }
    : undefined;
  // The pace is read before the channel opens, so a state chain that cannot be read opens none
  const [quoted, pace] = await Promise.all([
    quoteOutgoing(args.sdk, args.amount, args.destination, source, quoteCcm),
    chainPace(args.rpc ?? chainflipRpc(args.network), source.chain),
  ]);
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
    ...(args.ccm ? { ccm: args.ccm } : {}),
  });
  // Chainflip's own time estimate prices every block alike, so the block is timed live instead
  if (channel.expiryBlock === undefined) {
    throw new Error("Chainflip named no expiry block for the channel");
  }
  return {
    id: channel.depositChannelId,
    address: channel.deposit.address,
    expiresAt: channelExpiresAt(pace, channel.expiryBlock),
    expectedEgress: quoted.egressAmount,
  };
}
