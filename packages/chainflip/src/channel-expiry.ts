// When Chainflip closes a deposit channel, at the pace it tracked the source chain lately.

import type { ChainflipNetworkId } from "./sdk";

// Chainflip's public state chain RPCs, as @chainflip/rpc's PUBLIC_RPC_ENDPOINTS names them
const CHAINFLIP_RPC = "https://rpc.mainnet.chainflip.io";
// An archive node, so the pace window's past blocks are served
const CHAINFLIP_RPC_PERSEVERANCE = "https://archive.perseverance.chainflip.io";

/** One JSON-RPC call against Chainflip's state chain, resolving its result. */
export type ChainflipRpc = (method: string, params: unknown[]) => Promise<unknown>;

/** The state chain RPC of a Chainflip network. */
export const chainflipRpcUrl = (network: ChainflipNetworkId): string =>
  network === "perseverance" ? CHAINFLIP_RPC_PERSEVERANCE : CHAINFLIP_RPC;

/** How long one state chain call may take, so a stalled RPC fails the channel open instead of hanging it. */
const RPC_TIMEOUT_MS = 10_000;

/** A JSON-RPC client over fetch that throws on anything but a result, so the caller refuses. */
export function chainflipRpc(network: ChainflipNetworkId): ChainflipRpc {
  const url = chainflipRpcUrl(network);
  return async (method, params) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Chainflip ${method} failed: HTTP ${response.status}`);
    const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error !== undefined || body.result === undefined) {
      throw new Error(`Chainflip ${method} failed: ${body.error?.message ?? "no result"}`);
    }
    return body.result;
  };
}

/** An hour of Chainflip's 6 s blocks: its stepped view of the source chain moves the pace ~1%. */
export const PACE_WINDOW_BLOCKS = 600;

// The storage key of Timestamp.Now, twox128("Timestamp") ++ twox128("Now")
const TIMESTAMP_NOW_KEY = "0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb";

// A SCALE u64 as Chainflip stores it, little-endian hex
function u64le(value: unknown): number {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{16}$/.test(value)) {
    throw new Error("Chainflip served no timestamp");
  }
  const bytes = value.slice(2).match(/../g)!;
  return Number(BigInt(`0x${bytes.reverse().join("")}`));
}

// The source chain's height as Chainflip tracks it, by the SDK's chain name
function trackedHeight(heights: unknown, chain: string): number {
  const height = (heights as Record<string, unknown> | null)?.[chain.toLowerCase()];
  if (typeof height !== "number") throw new Error(`Chainflip tracks no ${chain} height`);
  return height;
}

/** Chainflip's tracked height of a source chain, when it was read, and its recent ms per block. */
export interface ChainPace {
  height: number;
  at: number;
  msPerBlock: number;
}

/** The pace Chainflip tracked `chain` at across the last window, read before a channel opens. */
export async function chainPace(rpc: ChainflipRpc, chain: string): Promise<ChainPace> {
  const header = (await rpc("chain_getHeader", [])) as { number?: unknown };
  const best = Number(header.number);
  if (!Number.isSafeInteger(best) || best <= PACE_WINDOW_BLOCKS) {
    throw new Error("Chainflip served no best block");
  }
  const read = async (block: number) => {
    const hash = await rpc("chain_getBlockHash", [block]);
    const [heights, stamp] = await Promise.all([
      rpc("cf_monitoring_external_chains_block_height", [hash]),
      rpc("state_getStorage", [TIMESTAMP_NOW_KEY, hash]),
    ]);
    return { height: trackedHeight(heights, chain), at: u64le(stamp) };
  };
  const [now, then] = await Promise.all([read(best), read(best - PACE_WINDOW_BLOCKS)]);
  if (now.height <= then.height || now.at <= then.at) {
    throw new Error(`Chainflip has not tracked ${chain} lately`);
  }
  return { ...now, msPerBlock: (now.at - then.at) / (now.height - then.height) };
}

/** When a channel expiring at `expiryBlock` closes at `pace`, ms since the epoch. */
export const channelExpiresAt = (pace: ChainPace, expiryBlock: bigint): number =>
  Math.floor(pace.at + Number(expiryBlock - BigInt(pace.height)) * pace.msPerBlock);
