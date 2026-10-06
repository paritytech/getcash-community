import {
  createPapiProvider,
  deriveEntropy as hostDeriveEntropy,
  hostLocalStorage,
  paymentManager,
} from "@novasamatech/host-api-wrapper";

/**
 * The worker's host-api client, presented in the shapes the engine consumes. Only one host-api
 * client may exist per executable.
 */

/** Product storage: `readJSON`/`writeJSON`/`clear`; absent reads are falsy. */
export async function getHostLocalStorage() {
  return hostLocalStorage;
}

/** A papi provider routed through the host for `genesisHash`. */
export async function getHostProvider(genesisHash) {
  return createPapiProvider(genesisHash);
}

/** Entropy for `key`, as `{ ok, value | error }`. Accepts a neverthrow Result or a plain object. */
export async function deriveEntropy(key) {
  const result = await hostDeriveEntropy(key);
  const ok = typeof result.isOk === "function" ? result.isOk() : Boolean(result.ok);
  return ok ? { ok: true, value: result.value } : { ok: false, error: result.error };
}

/**
 * Registers a claim of `amount` of the burner's CASH into the user's purse, using the burner's
 * 64-byte sr25519 secret. Resolves once the host has accepted the top-up; the claim itself is
 * driven by the host and followed through `followTopUpStatus`.
 */
export function registerTopUp(amount, secretKey, id) {
  return paymentManager.topUp(amount, { type: "privateKey", key: secretKey }, id);
}

/**
 * Follows the top-up registered under `id` until the returned function is called. Hosts replay
 * the latest status on subscribe. `onInterrupt` receives the host's interrupt error,
 * `PaymentTopUpStatusErr.NotFound` for an unknown id, and nothing more arrives after it.
 */
export function followTopUpStatus(id, onStatus, onInterrupt) {
  const subscription = paymentManager.subscribeTopUpStatus(id, onStatus);
  subscription.onInterrupt(onInterrupt);
  return () => subscription.unsubscribe();
}
