// The providers this worker can follow, and the hand that pays them. The channel itself is
// opened on the page, and arrives with the hand-off; here a provider is only asked how the swap
// behind it is going, one fetch per tick. Chainflip carries the crypto destinations, Meld the
// fiat ones; the pickers grey a route until its provider is here.

import { readChannelRecord, readSwapStatus } from "@getsome/chainflip/swap-status";
import { createMeldClient, readSaleChannel, readSaleStatus } from "@getsome/meld";
import {
  DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS,
  DEFAULT_WITHDRAW_TICK_TIMEOUT_MS,
  exactPaymentLanded,
  payExactOnce,
  readAssetHubAccount,
  readDestinationPas,
  sweepOnce,
} from "@getsome/withdraw";
import { paseo_next_v2 } from "@polkadot-api/descriptors";
import {
  ANCHOR_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  connectChain,
  keypairFor,
  signOptionsFor,
} from "./shared.js";

/** Room for the host calls a payment makes without a bound of their own: the key's derivation
 *  and the save before the broadcast. */
const HOST_CALLS_MS = 30_000;

/**
 * How long either hand below may take: the chain connection and its anchor, the key read and the
 * dry run on the tick bound, the submit on its own, and the host calls. The rail leg's outer bound
 * is this, so it never fires while a transfer is still in flight and a second tick starts over it.
 */
export const PAY_TIMEOUT_MS =
  CONNECT_TIMEOUT_MS +
  ANCHOR_TIMEOUT_MS +
  2 * DEFAULT_WITHDRAW_TICK_TIMEOUT_MS +
  DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS +
  HOST_CALLS_MS;

/**
 * The provider client for a job, or null when this build has none for its rail. Two calls:
 * `status(id)` is the provider's word on the swap behind the channel, and `channel(id)` is its
 * own record of the channel, which the leg checks the withdrawal against before the key pays.
 *
 * Meld is read through the adapter the page named in the hand-off. A page that ran the offline
 * sale names none and says so: its stand-in provider has no record to check, is trusted as the
 * hand-off describes it, and never settles, so the demo Skip ends it.
 */
export function railFor(provider, record) {
  if (provider === "chainflip") {
    return { status: (id) => readSwapStatus(id), channel: (id) => readChannelRecord(id) };
  }
  if (provider === "meld") {
    const meld = record?.meld;
    if (meld?.offline === true) return { status: async () => ({ status: "receiving" }) };
    if (typeof meld?.baseUrl !== "string" || meld.baseUrl === "") return null;
    const client = createMeldClient({
      baseUrl: meld.baseUrl,
      ...(typeof meld.productId === "string" && meld.productId
        ? { productId: meld.productId }
        : {}),
    });
    return {
      status: (id) => readSaleStatus(client, id),
      channel: (id) => readSaleChannel(client, id),
    };
  }
  return null;
}

/**
 * Pays the channel exactly `amount` from the key on Asset Hub, at the nonce `exact` keeps.
 * Resolves once the payment is on chain. `hooks.onBeforeSubmit` runs before the broadcast, so the
 * driver can persist the attempt; `hooks.onTx` takes the transaction as it lands.
 */
export async function payRailExact(record, handoff, amount, exact, hooks = {}) {
  const key = await keypairFor(record.label);
  const client = await connectChain(record.assetHubGenesis, "asset hub");
  try {
    const assetHubApi = client.getTypedApi(paseo_next_v2);
    await payExactOnce(
      {
        assetHubApi,
        key: { address: key.address, signer: key.signer },
        to: handoff.address,
        amount,
        tickTimeoutMs: DEFAULT_WITHDRAW_TICK_TIMEOUT_MS,
        submitTimeoutMs: DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS,
        signOptions: await signOptionsFor(client),
        readKey: () => readAssetHubAccount(assetHubApi, record.keyPublicKeyHex),
        onBeforeSubmit: hooks.onBeforeSubmit,
        onTx: hooks.onTx,
      },
      exact,
    );
  } finally {
    client.destroy();
  }
}

/**
 * Whether the exact payment's earlier attempt landed, from the key on Asset Hub alone. Connects
 * only when an attempt is in flight; the rail leg asks it before the provider.
 */
export async function exactPaymentOut(record, amount, exact) {
  if (!exact.inFlight) return false;
  const client = await connectChain(record.assetHubGenesis, "asset hub");
  try {
    const assetHubApi = client.getTypedApi(paseo_next_v2);
    return await exactPaymentLanded(
      {
        amount,
        tickTimeoutMs: DEFAULT_WITHDRAW_TICK_TIMEOUT_MS,
        readKey: () => readAssetHubAccount(assetHubApi, record.keyPublicKeyHex),
      },
      exact,
    );
  } finally {
    client.destroy();
  }
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
