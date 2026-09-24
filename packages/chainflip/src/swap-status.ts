// A swap's status read with plain fetch, for the worker: one GET against Chainflip's API and the
// same mapping the page uses. Nothing else of Chainflip's is needed there, and its SDK brings
// half of Node along, so this module stays clear of it and is exported on its own path.
//
// Mainnet only. Chainflip's test network serves none of the chains this app runs on, so there is
// no other network to name.

import type { SwapStatusResult } from "@getsome/core";
import { getSwapStatus, type StatusBackend } from "./status";

/** Chainflip's swap API; the SDK's own default. */
export const CHAINFLIP_SWAP_API = "https://chainflip-swap.chainflip.io";

export type FetchLike = (
  url: string,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** A status backend over fetch; throws on anything but a 2xx, so a tick retries later. */
export function createFetchStatusBackend(
  fetchImpl: FetchLike = (url) => fetch(url),
): StatusBackend {
  return {
    async getStatusV2({ id }) {
      const response = await fetchImpl(`${CHAINFLIP_SWAP_API}/v2/swaps/${id}`);
      if (!response.ok) throw new Error(`Chainflip status read failed: HTTP ${response.status}`);
      return response.json();
    },
  };
}

/** The provider's word on the swap behind a channel. */
export const readSwapStatus = (
  channelId: string,
  fetchImpl?: FetchLike,
): Promise<SwapStatusResult> => getSwapStatus(createFetchStatusBackend(fetchImpl), channelId);

/** Chainflip's own record of a channel, for checking a withdrawal against before the key pays it.
 *  Every field is served from the moment the channel opens, before any deposit. */
export interface ChainflipChannelRecord {
  /** Where Chainflip expects the deposit. */
  depositAddress: string;
  /** Where the swap pays out: the address the user gave. */
  destinationAddress: string;
  /** Chainflip's own word on the channel being closed, rather than our stored clock. */
  expired: boolean;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

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
  fetchImpl: FetchLike = (url) => fetch(url),
): Promise<ChainflipChannelRecord | null> {
  const response = await fetchImpl(`${CHAINFLIP_SWAP_API}/v2/swaps/${channelId}`);
  if (!response.ok) throw new Error(`Chainflip channel read failed: HTTP ${response.status}`);
  const body = (await response.json()) as {
    destAddress?: unknown;
    depositChannel?: { depositAddress?: unknown; isExpired?: unknown };
  };
  const channel = body.depositChannel;
  if (typeof channel !== "object" || channel === null) return null;
  const depositAddress = str(channel.depositAddress);
  if (depositAddress === "") return null;
  return {
    depositAddress,
    destinationAddress: str(body.destAddress),
    expired: channel.isExpired === true,
  };
}
