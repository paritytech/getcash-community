// The Chainflip SDK this app talks to, for prices, floors and durations. Nothing here opens a
// deposit channel.

import { createSwapSdk, type ChainflipNetworkId, type SwapSdkLike } from "@getsome/chainflip";

export const NETWORK: ChainflipNetworkId = "mainnet";

let sdkPromise: Promise<SwapSdkLike> | null = null;

/** The real SDK, built once and lazily. A failed build is not cached. */
export function mainnetSdk(): Promise<SwapSdkLike> {
  sdkPromise ??= createSwapSdk(NETWORK).catch((e: unknown) => {
    sdkPromise = null;
    throw e;
  });
  return sdkPromise;
}
