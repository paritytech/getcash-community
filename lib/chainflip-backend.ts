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
import { readChannelRecord, type ChainflipChannelRecord } from "@getsome/chainflip/swap-status";
import {
  NETWORK as CHAIN_NETWORK,
  type ChainflipRail,
  type DepositChannel,
  type OpenChannelArgs,
} from "@getsome/core";
import { sameChannelAddress } from "@getsome/withdraw";
import { devLog } from "./log";

export const NETWORK: ChainflipNetworkId = "mainnet";

const CHANNEL_READ_TRIES = 15;
const CHANNEL_READ_WAIT_MS = 2_000;

type ChannelRead = (id: string) => Promise<ChainflipChannelRecord | null>;

async function readOpenedChannel(id: string, read: ChannelRead, waitMs: number) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read(id);
    } catch (error) {
      if (attempt >= CHANNEL_READ_TRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

function channelMismatch(
  record: ChainflipChannelRecord | null,
  channel: DepositChannel,
  args: OpenChannelArgs,
  egress: { chain: string; asset: string },
): string | null {
  if (record === null) return "Chainflip cannot name it";
  const addresses = [
    ["deposit", record.depositAddress, channel.deposit.address],
    ["payout", record.destinationAddress, args.destAddress],
    ["refund", record.refundAddress, args.refundAddress ?? ""],
  ] as const;
  for (const [name, served, asked] of addresses) {
    if (asked.trim() === "" || !sameChannelAddress(served, asked)) {
      return `its ${name} address is '${served}', not '${asked}'`;
    }
  }
  if (record.destinationChain !== egress.chain || record.destinationAsset !== egress.asset) {
    return `it pays out '${record.destinationAsset}' on '${record.destinationChain}', not ${egress.asset} on ${egress.chain}`;
  }
  return null;
}

export function checkedAgainstChainflip(
  rail: ChainflipRail,
  egress: { chain: string; asset: string },
  read: ChannelRead = (id) => readChannelRecord(id, undefined, NETWORK),
  waitMs = CHANNEL_READ_WAIT_MS,
): ChainflipRail {
  return {
    ...rail,
    async requestDepositAddress(args) {
      const channel = await rail.requestDepositAddress(args);
      const record = await readOpenedChannel(channel.depositChannelId, read, waitMs);
      const mismatch = channelMismatch(record, channel, args, egress);
      if (mismatch !== null) {
        throw new Error(
          `Chainflip's record of channel ${channel.depositChannelId} does not match the top-up: ${mismatch}`,
        );
      }
      return channel;
    },
  };
}

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
  devLog(
    "chainflip",
    "VITE_CHAINFLIP_BROKER_API_KEY is unset; channels cannot be opened",
    undefined,
    "warn",
  );
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

/** The network a fiat sale's swap runs on: Perseverance on a test build, where its quotes and
 *  channels are real but no chain the build runs on is watched, so the key cannot pay one. */
export const SALE_SWAP_NETWORK: ChainflipNetworkId = CHAIN_NETWORK.testnet
  ? "perseverance"
  : "mainnet";

/** Whether Perseverance still opens channels on Chainflip's default broker. The BaaS broker is
 *  mainnet's only; mainnet refuses the default one since #92. Not yet confirmed for Perseverance:
 *  set false if it starts refusing too, and test builds stop offering the swap lanes. */
const PERSEVERANCE_DEFAULT_BROKER_OPENS = true;

/** Whether a fiat sale's swap channel can be opened in this build. Asked before a lane is quoted,
 *  so a sale whose channel would be refused at pay is never offered, and no seller does KYC for it. */
export const saleChannelsOpen = (): boolean =>
  SALE_SWAP_NETWORK === NETWORK ? brokerConfigured() : PERSEVERANCE_DEFAULT_BROKER_OPENS;

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
