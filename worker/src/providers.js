// The providers this worker can hand a withdrawal to, and the hand that pays them. No provider
// client yet: the pickers keep every provider route greyed until one lands here, and a job that
// reaches the rail leg without one fails plainly rather than waiting on nothing.

import {
  DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS,
  DEFAULT_WITHDRAW_TICK_TIMEOUT_MS,
  readDestinationPas,
  sweepOnce,
} from "@getsome/withdraw";
import { paseo_next_v2 } from "@polkadot-api/descriptors";
import { connectChain, keypairFor, signOptionsFor } from "./shared.js";

/**
 * The provider client for a job, bound to that job, or null when this build has none. A client
 * has two calls: `open()`, the channel and the Asset Hub account the key pays, and `status(id)`,
 * the provider's word on the swap.
 */
export function railFor(_provider, _record) {
  return null;
}

/**
 * Pays the channel: everything the key holds on Asset Hub, in one transfer that reaps the key.
 * Resolves once the key is empty. `hooks.onBeforeSubmit` runs before the broadcast, so the
 * driver can persist the attempt; `hooks.onTx` takes the transaction as it lands.
 */
export async function payRail(record, handoff, sweep, hooks = {}) {
  const key = await keypairFor(record.label);
  const client = await connectChain(record.assetHubGenesis, "asset hub");
  try {
    const assetHubApi = client.getTypedApi(paseo_next_v2);
    await sweepOnce(
      {
        assetHubApi,
        key: { signer: key.signer },
        to: handoff.address,
        tickTimeoutMs: DEFAULT_WITHDRAW_TICK_TIMEOUT_MS,
        submitTimeoutMs: DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS,
        signOptions: await signOptionsFor(client),
        readKeyOnAssetHub: () => readDestinationPas(assetHubApi, record.keyPublicKeyHex),
        onBeforeSubmit: hooks.onBeforeSubmit,
        onTx: hooks.onTx,
      },
      sweep,
    );
  } finally {
    client.destroy();
  }
}
