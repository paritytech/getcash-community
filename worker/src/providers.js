// The providers this worker can follow, and the hand that pays them. The channel itself is
// opened on the page, at confirm, and arrives with the hand-off; here a provider is only asked
// how the swap behind it is going, one fetch per tick. Chainflip carries the crypto
// destinations; the pickers grey a route until its provider is here.

import { readSwapStatus } from "@getsome/chainflip/swap-status";
import {
  DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS,
  DEFAULT_WITHDRAW_TICK_TIMEOUT_MS,
  readDestinationPas,
  sweepOnce,
} from "@getsome/withdraw";
import { paseo_next_v2 } from "@polkadot-api/descriptors";
import { connectChain, keypairFor, signOptionsFor } from "./shared.js";

/**
 * The provider client for a job, or null when this build has none for its rail. A client has
 * one call, `status(id)`: the provider's word on the swap behind the channel.
 */
export function railFor(provider, _record) {
  if (provider !== "chainflip") return null;
  return { status: (id) => readSwapStatus(id) };
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
