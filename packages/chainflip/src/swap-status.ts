// A swap's status read with plain fetch, for the worker: one GET against Chainflip's API and the
// same mapping the page uses. Nothing else of Chainflip's is needed there, and its SDK brings
// half of Node along, so this module stays clear of it and is exported on its own path.
//
// Mainnet by default. A test build reads Perseverance, Chainflip's test network: it opens real
// channels and quotes, though it watches none of the chains this app runs on.

import type { SwapStatusResult, TokenSpec } from "@getsome/core";
import type { ChainflipNetworkId } from "./sdk";
import { getSwapStatus, type StatusBackend } from "./status";

/** Chainflip's swap API; the SDK's own default. */
export const CHAINFLIP_SWAP_API = "https://chainflip-swap.chainflip.io";
/** The same API on Perseverance. */
export const CHAINFLIP_SWAP_API_PERSEVERANCE = "https://chainflip-swap-perseverance.chainflip.io";

const swapApiFor = (network: ChainflipNetworkId): string =>
  network === "perseverance" ? CHAINFLIP_SWAP_API_PERSEVERANCE : CHAINFLIP_SWAP_API;

const swapUrl = (network: ChainflipNetworkId, id: string): string =>
  `${swapApiFor(network)}/v2/swaps/${encodeURIComponent(id)}`;

export type FetchLike = (
  url: string,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const READ_TIMEOUT_MS = 10_000;

const fetchWithin: FetchLike = (url) =>
  fetch(url, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });

/** A status backend over fetch; throws on anything but a 2xx, so a tick retries later. */
export function createFetchStatusBackend(
  fetchImpl: FetchLike = fetchWithin,
  network: ChainflipNetworkId = "mainnet",
): StatusBackend {
  return {
    async getStatusV2({ id }) {
      const response = await fetchImpl(swapUrl(network, id));
      if (!response.ok) throw new Error(`Chainflip status read failed: HTTP ${response.status}`);
      return response.json();
    },
  };
}

/** The provider's word on the swap behind a channel. */
export const readSwapStatus = (
  channelId: string,
  fetchImpl?: FetchLike,
  network: ChainflipNetworkId = "mainnet",
): Promise<SwapStatusResult> =>
  getSwapStatus(createFetchStatusBackend(fetchImpl, network), channelId);

/** Chainflip's own record of a channel, for checking a withdrawal against before the key pays it.
 *  Every field is served from the moment the channel opens, before any deposit. */
export interface ChainflipChannelRecord {
  /** Where Chainflip expects the deposit. */
  depositAddress: string;
  /** Where the swap pays out: the address the user gave. */
  destinationAddress: string;
  destinationChain: string;
  destinationAsset: string;
  refundAddress: string;
  sourceChain: string;
  sourceAsset: string;
  /** What the channel's brokers take between them, basis points; NaN when one does not say. */
  commissionBps: number;
  /** The price under which the swap refunds, destination per source; NaN or 0 when none is set. */
  minPrice: number;
  /** Chainflip's own word on the channel being closed, rather than our stored clock. */
  expired: boolean;
}

export interface ChannelSource {
  chain: string;
  asset: string;
}

export const assetHubSource = (token: TokenSpec): ChannelSource => ({
  chain: "Assethub",
  asset: token.chainflipAsset ?? "",
});

/** Four times what BaaS takes today, so a raise on its side does not stop every channel. */
export const MAX_CHANNEL_COMMISSION_BPS = 20;

/** Chainflip stores the minimum price in another encoding and serves it back rounded. */
const MIN_PRICE_ROUNDING = 1e-4;

/** What is wrong with the terms Chainflip holds for a channel paid from `source`, or null. */
export function channelTermsFault(
  record: ChainflipChannelRecord,
  source: ChannelSource,
  minPrice = 0,
): string | null {
  if (record.sourceChain !== source.chain || record.sourceAsset !== source.asset) {
    return `it takes '${record.sourceAsset}' on '${record.sourceChain}', not ${source.asset} on ${source.chain}`;
  }
  if (!(record.commissionBps <= MAX_CHANNEL_COMMISSION_BPS)) {
    return `its brokers take ${record.commissionBps} bps, over the ${MAX_CHANNEL_COMMISSION_BPS} allowed`;
  }
  if (!(record.minPrice > 0 && record.minPrice >= minPrice * (1 - MIN_PRICE_ROUNDING))) {
    return `its minimum price is ${record.minPrice}, under ${minPrice}`;
  }
  return null;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

const commissionOf = (brokers: unknown): number =>
  Array.isArray(brokers)
    ? brokers.reduce<number>((sum, broker: { commissionBps?: unknown } | null) => {
        const bps = broker?.commissionBps;
        return sum + (typeof bps === "number" ? bps : Number.NaN);
      }, 0)
    : 0;

/**
 * Chainflip's record of the channel, read back by its id. Returns null when Chainflip answers but
 * serves no channel fields, which is itself an answer: nothing should be paid into a channel the
 * provider cannot name.
 *
 * Throws on any read that did not answer, a 404 included. A channel is opened moments before a
 * retried withdrawal ticks, so a not-found can be Chainflip not having indexed it yet rather than
 * a channel that does not exist. Both refuse to pay; a throw retries on the next tick instead of
 * burning the job on a race.
 */
export async function readChannelRecord(
  channelId: string,
  fetchImpl: FetchLike = fetchWithin,
  network: ChainflipNetworkId = "mainnet",
): Promise<ChainflipChannelRecord | null> {
  const response = await fetchImpl(swapUrl(network, channelId));
  if (!response.ok) throw new Error(`Chainflip channel read failed: HTTP ${response.status}`);
  const body = (await response.json()) as {
    destAddress?: unknown;
    destChain?: unknown;
    destAsset?: unknown;
    srcChain?: unknown;
    srcAsset?: unknown;
    brokers?: unknown;
    fillOrKillParams?: { refundAddress?: unknown; minPrice?: unknown } | null;
    depositChannel?: { depositAddress?: unknown; isExpired?: unknown };
  };
  const channel = body.depositChannel;
  if (typeof channel !== "object" || channel === null) return null;
  const depositAddress = str(channel.depositAddress);
  if (depositAddress === "") return null;
  return {
    depositAddress,
    destinationAddress: str(body.destAddress),
    destinationChain: str(body.destChain),
    destinationAsset: str(body.destAsset),
    refundAddress: str(body.fillOrKillParams?.refundAddress),
    sourceChain: str(body.srcChain),
    sourceAsset: str(body.srcAsset),
    commissionBps: commissionOf(body.brokers),
    minPrice: Number(str(body.fillOrKillParams?.minPrice)),
    expired: channel.isExpired === true,
  };
}
