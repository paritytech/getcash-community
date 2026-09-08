// Chain connections for both run modes. Inside a host container all chain access rides the
// host's JSON-RPC provider; standalone speaks WebSocket directly. Every path is time-bounded
// and liveness-checked.

import type { PolkadotClient } from "polkadot-api";
import { withTimeout } from "./timeout";
// The genesis hashes come from the file papi regenerates with the descriptors.
import papiConfig from "../.papi/polkadot-api.json";

export const ASSET_HUB_WS = "wss://paseo-asset-hub-next-rpc.polkadot.io";
export const PEOPLE_WS = "wss://paseo-people-next-system-rpc.polkadot.io";

export const ASSET_HUB_GENESIS = papiConfig.entries.paseo_next_v2.genesis as `0x${string}`;
export const PEOPLE_GENESIS = papiConfig.entries.paseo_people_next.genesis as `0x${string}`;

export interface ChainTarget {
  /** Short name for logs and errors, e.g. "asset-hub". */
  label: string;
  genesisHash: `0x${string}`;
  wsUrl: string;
}

export const ASSET_HUB: ChainTarget = {
  label: "asset-hub",
  genesisHash: ASSET_HUB_GENESIS,
  wsUrl: ASSET_HUB_WS,
};

export const PEOPLE: ChainTarget = {
  label: "people",
  genesisHash: PEOPLE_GENESIS,
  wsUrl: PEOPLE_WS,
};

// Bounds for the host probe and the liveness checks. Their sum stays under the quote UI's
// outer step bound.
const HOST_PROBE_TIMEOUT_MS = 8_000;
const HOST_LIVENESS_TIMEOUT_MS = 10_000;
const WS_LIVENESS_TIMEOUT_MS = 25_000;

type HostProbe =
  | {
      provider: NonNullable<
        Awaited<ReturnType<typeof import("@parity/product-sdk-host").getHostProvider>>
      >;
    }
  | { provider: null; reason: string };

/** Resolves the host-routed provider, or the reason there is none. Never throws. */
async function probeHostProvider(target: ChainTarget): Promise<HostProbe> {
  const { getHostProvider } = await import("@parity/product-sdk-host");
  try {
    const provider = await withTimeout(
      getHostProvider(target.genesisHash),
      HOST_PROBE_TIMEOUT_MS,
      `host chain probe (${target.label})`,
    );
    if (provider) return { provider };
    return { provider: null, reason: "not inside a host container" };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(`[chain] ${target.label}: host provider unavailable:`, reason);
    return { provider: null, reason };
  }
}

/** Confirms the client serves `target`: the transport answers, a finalized block exists, and
 *  the genesis matches. Metadata is not fetched here. */
async function verifyLive(
  client: PolkadotClient,
  target: ChainTarget,
  via: string,
  ms: number,
): Promise<void> {
  const [spec] = await withTimeout(
    Promise.all([client.getChainSpecData(), client.getFinalizedBlock()]),
    ms,
    `${target.label} chain connection (${via})`,
  );
  if (spec.genesisHash !== target.genesisHash) {
    throw new Error(
      `${target.label} genesis mismatch (${via}): chain reports ${spec.genesisHash}, ` +
        `expected ${target.genesisHash}; the testnet may have been reset`,
    );
  }
}

// One verified client per chain per app run.
const clientCache = new Map<string, Promise<PolkadotClient>>();

async function dialChain(target: ChainTarget): Promise<PolkadotClient> {
  const { createClient } = await import("polkadot-api");
  const { isInsideContainerSync } = await import("@parity/product-sdk-host");

  if (isInsideContainerSync()) {
    // In a host container chain access comes from the host. There is no WebSocket fallback.
    const probe = await probeHostProvider(target);
    if (!probe.provider) {
      throw new Error(`${target.label} chain: host did not provide access: ${probe.reason}`);
    }
    const client = createClient(probe.provider);
    try {
      await verifyLive(client, target, "host-routed", HOST_LIVENESS_TIMEOUT_MS);
    } catch (e) {
      client.destroy();
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`${target.label} chain: host-routed connection failed: ${reason}`);
    }
    console.info(`[chain] ${target.label}: host-routed provider`);
    return client;
  }

  // Standalone (plain browser dev): speak to the RPC directly.
  const { getWsProvider } = await import("polkadot-api/ws");
  const client = createClient(getWsProvider(target.wsUrl));
  try {
    await verifyLive(client, target, "WebSocket", WS_LIVENESS_TIMEOUT_MS);
  } catch (e) {
    client.destroy();
    throw e instanceof Error ? e : new Error(String(e));
  }
  console.info(`[chain] ${target.label}: direct WebSocket (${target.wsUrl})`);
  return client;
}

/**
 * Connects a papi client to `target`: host-routed when the host advertises the chain, direct
 * WebSocket otherwise. The client is shared per chain; callers must not destroy it.
 */
export function connectChain(target: ChainTarget): Promise<PolkadotClient> {
  let pending = clientCache.get(target.label);
  if (!pending) {
    pending = dialChain(target);
    clientCache.set(target.label, pending);
    pending.catch(() => clientCache.delete(target.label));
  }
  return pending;
}

/**
 * Starts dialing both chains without waiting. Best effort: a failed dial evicts its cache entry.
 */
export function prewarmChains(): void {
  connectChain(PEOPLE).catch(() => {});
  connectChain(ASSET_HUB).catch(() => {});
}

/** Tears down and forgets both cached clients; the next connectChain re-dials. */
export function evictChains(): void {
  for (const [label, pending] of clientCache) {
    clientCache.delete(label);
    pending.then((client) => client.destroy()).catch(() => {});
  }
}
