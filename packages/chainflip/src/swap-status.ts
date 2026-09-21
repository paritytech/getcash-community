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
