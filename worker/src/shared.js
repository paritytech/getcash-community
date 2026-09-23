import { deriveKeypairWithSecret } from "@getsome/ephemeral";
import { createClient } from "polkadot-api";
import { deriveEntropy, getHostLocalStorage, getHostProvider } from "./host.js";

// What both engines need of the host and the chains: a job map in product storage, a bounded
// wait, a chain client for one tick, the anchor of a submit, and the key a label derives.

/**
 * A job map under `storageKey`, loaded once and single-flight, saved after every change. A
 * failed load throws and caches nothing.
 *
 * TWO SAVES, AND THE DIFFERENCE MATTERS. `save` is best-effort: a write that does not land is
 * warned about and the map keeps answering from memory, which is right for bookkeeping a later
 * save will carry anyway. `saveStrict` throws. Anything a broadcast must not outrun — a nonce
 * pinned so a retry cannot pay twice — has to use it, because a silent write failure there means
 * the next reload has no memory of a transaction that is already on its way, and the caller must
 * be able to stop before sending it.
 */
export function createJobStore(storageKey, label) {
  let jobs = null;
  let loading = null;

  async function read() {
    const store = await getHostLocalStorage();
    if (!store) throw new Error("product storage unavailable");
    const stored = await store.readJSON(storageKey);
    jobs = stored && typeof stored === "object" ? stored : {};
    return jobs;
  }

  async function write() {
    const store = await getHostLocalStorage();
    if (!store) throw new Error("product storage unavailable");
    await store.writeJSON(storageKey, jobs);
  }

  return {
    load() {
      if (jobs) return Promise.resolve(jobs);
      loading ??= read().finally(() => {
        loading = null;
      });
      return loading;
    },
    async save() {
      if (!jobs) return;
      try {
        await write();
      } catch (error) {
        console.warn(`[${label}] jobs write failed: ${String(error?.message ?? error)}`);
      }
    },
    async saveStrict() {
      if (!jobs) return;
      await write();
    },
  };
}

/** Parses a bigint stored as a string, with a fallback for bad input. */
export const asBig = (value, fallback = 0n) => {
  try {
    return BigInt(value);
  } catch {
    return fallback;
  }
};

export const toHex = (bytes) =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

/** Rejects with a timeout error when `promise` takes longer than `ms`. */
export function bounded(promise, ms, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Creates a papi client for `genesisHash` through the host and verifies the chain it serves.
 * Clients live for one tick and are destroyed when it ends.
 */
export async function connectChain(genesisHash, what) {
  const provider = await bounded(getHostProvider(genesisHash), 8_000, `${what} provider`);
  if (!provider) throw new Error(`${what}: no host provider (not in a container?)`);
  const client = createClient(provider);
  try {
    const spec = await bounded(client.getChainSpecData(), 10_000, `${what} chainSpec`);
    if (spec.genesisHash !== genesisHash) {
      throw new Error(`${what}: genesis mismatch: host routed ${spec.genesisHash}`);
    }
    return client;
  } catch (error) {
    client.destroy();
    throw error;
  }
}

/**
 * Anchors the mortal era and nonce of a submit to the client's best block. Throws when the tip
 * cannot be read.
 */
export async function signOptionsFor(client) {
  const best = await bounded(client.getBestBlocks(), 8_000, "best block");
  const hash = best?.[0]?.hash;
  if (!hash) throw new Error("no best block to anchor the submit against");
  return { at: hash };
}

/** The keypair the entropy label `label` derives, from host entropy. Never persisted. */
export async function keypairFor(label) {
  const result = await deriveEntropy(new TextEncoder().encode(label));
  if (!result.ok) {
    throw new Error(`deriveEntropy refused: ${String(result.error?.message ?? result.error)}`);
  }
  return deriveKeypairWithSecret(result.value);
}
