// The Chainflip SDK this app talks to, for prices, floors, durations and the channels a
// withdrawal opens. Channels open on the Broker-as-a-Service account the API key in the
// environment names, since Chainflip's own backend refuses channels on its default broker.

import {
  BAAS_COMMISSION_BPS,
  baasBrokerUrl,
  createSwapSdk,
  type ChainflipNetworkId,
  type SwapSdkLike,
} from "@getsome/chainflip";

export const NETWORK: ChainflipNetworkId = "mainnet";

/** The BaaS API key the build was given, or null when it has none. */
function brokerApiKey(): string | null {
  const raw = import.meta.env.VITE_CHAINFLIP_BROKER_API_KEY as string | undefined;
  const key = raw?.trim() ?? "";
  return key === "" ? null : key;
}

/** The broker RPC the channels open on, or null when the build has no key. */
function brokerUrl(): string | null {
  const key = brokerApiKey();
  return key === null ? null : baasBrokerUrl(key);
}

/** Whether this build can open channels at all. */
export const brokerConfigured = (): boolean => brokerUrl() !== null;

let sdkPromise: Promise<SwapSdkLike> | null = null;

/** The real SDK, built once and lazily. A failed build is not cached. */
export function mainnetSdk(): Promise<SwapSdkLike> {
  sdkPromise ??= buildSdk().catch((e: unknown) => {
    sdkPromise = null;
    throw e;
  });
  return sdkPromise;
}

/**
 * Without a key the SDK still quotes and reads status, and opening a channel is refused before
 * the SDK is asked, so its own checks on the amount or the address are never taken for a missing
 * key. The pickers grey the crypto withdrawals in that build, so this is a safety net.
 */
async function buildSdk(): Promise<SwapSdkLike> {
  const url = brokerUrl();
  if (url !== null) {
    return createSwapSdk(NETWORK, { brokerUrl: url, brokerCommissionBps: BAAS_COMMISSION_BPS });
  }
  console.warn("[chainflip] VITE_CHAINFLIP_BROKER_API_KEY is unset; channels cannot be opened");
  const sdk = await createSwapSdk(NETWORK);
  return {
    getQuoteV2: (args) => sdk.getQuoteV2(args),
    getStatusV2: (args) => sdk.getStatusV2(args),
    getSwapLimits: () => sdk.getSwapLimits(),
    requestDepositAddressV2: async () => {
      throw new Error("Chainflip channels are not available in this build");
    },
  };
}
