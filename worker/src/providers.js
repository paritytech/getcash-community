// The providers this worker can follow, and the hand that pays them. The channel itself is
// opened on the page, and arrives with the hand-off; here a provider is only asked how the swap
// behind it is going, one fetch per tick. Chainflip carries the crypto destinations, Meld the
// fiat ones; the pickers grey a route until its provider is here.

import { readChannelRecord, readSwapStatus } from "@getsome/chainflip/swap-status";
import { NETWORK } from "@getsome/core";
import { depositTokenOf, recordedRoute, stableTxOptions } from "@getsome/funding";
import {
  createMeldClient,
  devAdapterFetch,
  ensureMeldAssets,
  MELD_SELL_ENABLED,
  personhoodAdapterFetch,
  saleRail,
} from "@getsome/meld";
import { LANES, laneSellToken } from "@getsome/offramp";
import {
  ChannelMismatchError,
  DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS,
  DEFAULT_WITHDRAW_TICK_TIMEOUT_MS,
  exactPaymentLanded,
  finalizedChainOf,
  payExactOnce,
  readAssetHubAccount,
  readDestinationBalance,
  settleBlock,
  sweepOnce,
} from "@getsome/withdraw";
import { paseo_next_v2 } from "@polkadot-api/descriptors";
import {
  ANCHOR_TIMEOUT_MS,
  anchorFor,
  bounded,
  CONNECT_TIMEOUT_MS,
  connectChain,
  keypairFor,
  signOptionsFor,
} from "./shared.js";
import { getHostLocalStorage, proveLitePersonhood } from "./host.js";

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
 * Meld is read through the adapter the page named in the hand-off, the job keeping the count of
 * the adapter's not-found answers (`saleRail`). A page that ran the offline sale names none and
 * says so: its stand-in provider has no record to check, is trusted as the hand-off describes it,
 * and never settles, so the demo Skip ends it. Only on a test network, where the funds are too.
 */
export function railFor(provider, record) {
  if (provider === "chainflip") {
    return { status: (id) => readSwapStatus(id), channel: (id) => readChannelRecord(id) };
  }
  if (provider === "meld") {
    // Where the build does not sell for fiat, no sale is read or paid, whatever a hand-off says.
    if (!MELD_SELL_ENABLED) return null;
    const meld = record?.meld;
    if (meld?.offline === true) {
      return NETWORK.testnet ? { status: async () => ({ status: "receiving" }) } : null;
    }
    if (typeof meld?.baseUrl !== "string" || meld.baseUrl === "") return null;
    const fetchImpl = adapterFetchFor(meld);
    const client = createMeldClient({ baseUrl: meld.baseUrl, ...(fetchImpl ? { fetchImpl } : {}) });
    // A direct sale is paid in the token the hand-off's sale lands on the key.
    const rail = record?.swap
      ? swapSaleRail(saleRail(client, record, Date.now, LANE_TOKENS), record)
      : saleRail(client, record, Date.now, depositTokenOf(recordedRoute(record)));
    return withMeldAssets(rail, client);
  }
  return null;
}

const personhoodFetches = new Map();

/** Proves the worker to the adapter as the page that handed the sale off did. A personhood fetch
 *  is kept per adapter and product, and shares the page's stored token. */
function adapterFetchFor({ baseUrl, productId, auth }) {
  if (typeof productId !== "string" || !productId) return undefined;
  if (auth !== "personhood") return devAdapterFetch(productId);
  const key = `${baseUrl} ${productId}`;
  if (!personhoodFetches.has(key)) {
    personhoodFetches.set(
      key,
      personhoodAdapterFetch({
        baseUrl,
        productId,
        storage: {
          readJSON: async (k) => (await getHostLocalStorage()).readJSON(k),
          writeJSON: async (k, value) => (await getHostLocalStorage()).writeJSON(k, value),
        },
        prove: (message) => proveLitePersonhood(productId, message),
      }),
    );
  }
  return personhoodFetches.get(key);
}

/**
 * A sale's reads, each first reading the adapter's asset table (once per worker): the deposit
 * Meld discloses is matched against Meld's code for the asset, which the adapter names and Meld
 * renames. A failed read throws like any other, and the next tick asks again.
 */
function withMeldAssets(rail, client) {
  return {
    channel: async (id) => {
      await ensureMeldAssets(client);
      return rail.channel(id);
    },
    status: async (id) => {
      await ensureMeldAssets(client);
      return rail.status(id);
    },
  };
}

/** Chainflip's network for a sale's swap: Perseverance on a test network, as the page opens it. */
const SWAP_NETWORK = NETWORK.testnet ? "perseverance" : "mainnet";

/** What a swap sale's provider may be paid in: any lane's asset. */
const LANE_TOKENS = LANES.map(laneSellToken);

/**
 * A sale through an offramp lane: the key pays a Chainflip channel, which pays the provider. Before
 * the key pays, Meld's own record must name the deposit address and amount the hand-off carries,
 * so the Chainflip channel's destination is checked against the provider, not against the page.
 * The swap is followed until Chainflip delivers, then the sale until the provider pays out.
 */
function swapSaleRail(sale, record) {
  return {
    channel: async (id) => {
      const [swap, order] = await Promise.all([
        readChannelRecord(id, undefined, SWAP_NETWORK),
        sale.channel(record.channel.id),
      ]);
      if (swap === null) return null;
      if (order === null) {
        throw new ChannelMismatchError(`the provider cannot name sale ${record.channel.id}`);
      }
      if (order.depositAddress !== record.channel.address) {
        throw new ChannelMismatchError(
          `sale ${record.channel.id} takes deposits at ${order.depositAddress}, not ${record.channel.address}`,
        );
      }
      if (order.expectedAmount !== BigInt(record.channel.amount)) {
        throw new ChannelMismatchError(
          `sale ${record.channel.id} expects ${order.expectedAmount}, not ${record.channel.amount}`,
        );
      }
      return order.expired ? { ...swap, expired: true } : swap;
    },
    status: async (id) => {
      const swap = await readSwapStatus(id, undefined, SWAP_NETWORK);
      // Once Chainflip has delivered, no refund comes back to the key (see `refundMayLand`).
      if (swap.status !== "complete") return swap;
      return { ...(await sale.status(record.channel.id)), swapDelivered: true };
    },
  };
}

/**
 * Seats a payment not yet attempted at the key's live nonce on Asset Hub. The payment's state
 * starts at 0, the first nonce of a key the sale reaches by XCM alone; a sale on the PSM tier has
 * the key sign its redeem there first. A key that signed nothing is at 0 still.
 */
async function seedExactNonce(exact, readKey) {
  if (exact.inFlight || exact.nonce !== 0) return;
  exact.nonce = (
    await bounded(readKey(), DEFAULT_WITHDRAW_TICK_TIMEOUT_MS, "key nonce read")
  ).nonce;
}

/**
 * Pays the channel exactly `amount` of the token the sale landed from the key on Asset Hub, at the
 * nonce `exact` keeps. Resolves once the payment is on chain. `hooks.onBeforeSubmit` runs before
 * the broadcast, so the driver can persist the attempt; `hooks.onTx` takes the transaction as it
 * lands.
 */
export async function payRailExact(record, handoff, amount, exact, hooks = {}) {
  const key = await keypairFor(record.label);
  const token = depositTokenOf(recordedRoute(record));
  const client = await connectChain(record.assetHubGenesis, "asset hub");
  try {
    const assetHubApi = client.getTypedApi(paseo_next_v2);
    const readKey = () => readAssetHubAccount(assetHubApi, record.keyPublicKeyHex, token);
    await seedExactNonce(exact, readKey);
    const anchor = await anchorFor(client);
    await payExactOnce(
      {
        assetHubApi,
        key: { address: key.address, signer: key.signer },
        to: handoff.address,
        amount,
        token,
        tickTimeoutMs: DEFAULT_WITHDRAW_TICK_TIMEOUT_MS,
        submitTimeoutMs: DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS,
        signOptions: { at: anchor.hash },
        anchorNumber: anchor.number,
        readKey,
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
 * only when an attempt is in flight; the rail leg asks it before the provider. An attempt past
 * its mortality and still unlanded is taken out of flight (see `exactPaymentLanded`).
 */
export async function exactPaymentOut(record, amount, exact) {
  if (!exact.inFlight) return false;
  const token = depositTokenOf(recordedRoute(record));
  const client = await connectChain(record.assetHubGenesis, "asset hub");
  try {
    const assetHubApi = client.getTypedApi(paseo_next_v2);
    return await exactPaymentLanded(
      {
        amount,
        tickTimeoutMs: DEFAULT_WITHDRAW_TICK_TIMEOUT_MS,
        readKey: () => readAssetHubAccount(assetHubApi, record.keyPublicKeyHex, token),
        readFinalizedNumber: async () => (await client.getFinalizedBlock()).number,
      },
      exact,
    );
  } finally {
    client.destroy();
  }
}

/**
 * What became of the key's payment to the channel, seen in a best block: "final" once Asset Hub's
 * finalized chain holds that block, or shows the payment's effect in another; "pending" while it
 * is not past that block, or while the payment shows only at the best head; "gone" when it shows
 * nowhere, and the key pays again. A block that was replaced, or one too old for the chain to
 * name, says nothing of the payment itself, which usually landed in the block that took its
 * place: `shows(key)` reads its effect on the key, its balance in the sale's token and its nonce.
 */
export async function paymentOutcome(record, seen, shows) {
  const client = await connectChain(record.assetHubGenesis, "asset hub");
  try {
    const assetHubApi = client.getTypedApi(paseo_next_v2);
    const verdict = await settleBlock(
      finalizedChainOf(assetHubApi),
      seen,
      DEFAULT_WITHDRAW_TICK_TIMEOUT_MS,
    );
    if (verdict === "pending" || verdict === "final") return verdict;
    const token = depositTokenOf(recordedRoute(record));
    const read = (at) =>
      bounded(
        readAssetHubAccount(assetHubApi, record.keyPublicKeyHex, token, { at }),
        DEFAULT_WITHDRAW_TICK_TIMEOUT_MS,
        `key read on asset hub (${at})`,
      );
    if (shows(await read("finalized"))) return "final";
    if (shows(await read("best"))) return "pending";
    return "gone";
  } finally {
    client.destroy();
  }
}

/**
 * Pays the channel: everything the key holds on Asset Hub of the token the sale landed, in one
 * transfer that reaps the key. Resolves once the key is empty. `hooks.onBeforeSubmit` runs before
 * the broadcast, so the driver can persist the attempt; `hooks.onTx` takes the transaction as it
 * lands.
 */
export async function payRail(record, handoff, sweep, hooks = {}) {
  const key = await keypairFor(record.label);
  const sale = recordedRoute(record);
  const token = depositTokenOf(sale);
  // The key holds the sale's token and nothing else, so a stable pays the transfer's fee itself.
  const feeOptions = sale.external === undefined ? {} : stableTxOptions(sale.external);
  const client = await connectChain(record.assetHubGenesis, "asset hub");
  try {
    const assetHubApi = client.getTypedApi(paseo_next_v2);
    await sweepOnce(
      {
        assetHubApi,
        key: { signer: key.signer },
        to: handoff.address,
        token,
        tickTimeoutMs: DEFAULT_WITHDRAW_TICK_TIMEOUT_MS,
        submitTimeoutMs: DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS,
        signOptions: { ...feeOptions, ...(await signOptionsFor(client)) },
        readKeyOnAssetHub: () =>
          readDestinationBalance(assetHubApi, record.keyPublicKeyHex, token.assetHubId),
        onBeforeSubmit: hooks.onBeforeSubmit,
        onTx: hooks.onTx,
      },
      sweep,
    );
  } finally {
    client.destroy();
  }
}
