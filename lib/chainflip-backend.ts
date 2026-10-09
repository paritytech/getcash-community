// The Chainflip SDK this app talks to, for prices, floors and durations. Nothing here opens a
// deposit channel.

import { createSwapSdk, type ChainflipNetworkId, type SwapSdkLike } from "@getsome/chainflip";
import { NETWORK as CHAIN_NETWORK } from "@getsome/core";

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

/** The network a fiat sale's swap runs on: Perseverance on a test build, where its quotes and
 *  channels are real but no chain the build runs on is watched, so the key cannot pay one. */
export const SALE_SWAP_NETWORK: ChainflipNetworkId = CHAIN_NETWORK.testnet
  ? "perseverance"
  : "mainnet";

let saleSdkPromise: Promise<SwapSdkLike> | null = null;

/** The SDK for a fiat sale's swap, built once and lazily. A failed build is not cached. */
export function saleSwapSdk(): Promise<SwapSdkLike> {
  if (SALE_SWAP_NETWORK === NETWORK) return mainnetSdk();
  saleSdkPromise ??= createSwapSdk(SALE_SWAP_NETWORK).catch((e: unknown) => {
    saleSdkPromise = null;
    throw e;
  });
  return saleSdkPromise;
}
