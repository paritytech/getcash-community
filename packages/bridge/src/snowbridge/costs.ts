// The live reads of what the chains charge for a Snowbridge top-up. A trial message with fees far
// above what is needed runs on each chain in a dry run. Each chain then says what the message it
// receives costs. Nothing is sent.

import type { SnowbridgeCosts } from "./amounts";
import {
  ASSET_HUB,
  BRIDGE_HUB,
  dryRunXcm,
  HYDRATION,
  sibling,
  SnowbridgeReadError,
  versioned,
  type ChainReader,
  type XcmDryRun,
} from "./chain";
import type { XcmInstruction } from "./codec";
import { ETHER } from "./program";
import { deliveredProgram, type SnowbridgeMessage } from "./wrapper";

/** DOT, the token Asset Hub and Bridge Hub name their own fees in. */
const DOT = { parents: 1, interior: { type: "Here", value: undefined } };

/** The USDT of Asset Hub as Asset Hub names it. */
const USDT = {
  parents: 0,
  interior: {
    type: "X2",
    value: [
      { type: "PalletInstance", value: 50 },
      { type: "GeneralIndex", value: 1984n },
    ],
  },
};

/** The DOT that Snowbridge counts for the relayer's transaction on Bridge Hub: 0.025 DOT. Its
 *  own tools use this fixed figure, because the real fee needs the proof of a real message. */
const RELAYER_TRANSACTION_DOT = 250_000_000n;

/** Ether and the USDT of Asset Hub, by their numbers on Hydration. */
const ETHER_ON_HYDRATION = 34;
const USDT_ON_HYDRATION = 10;

export interface SnowbridgeChains {
  assetHub: ChainReader;
  bridgeHub: ChainReader;
  hydration: ChainReader;
}

/** What a trial message showed. */
export interface SnowbridgeTrial {
  costs: SnowbridgeCosts;
  /** The USDT the swap of the trial paid on Hydration, in base units. */
  usdtOut: bigint;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The value of a reply that says it succeeded. */
function granted(reply: unknown, what: string): unknown {
  if (!isRecord(reply) || reply.success !== true) {
    throw new SnowbridgeReadError(`no answer for ${what}`);
  }
  return reply.value;
}

function amount(value: unknown, what: string): bigint {
  if (typeof value !== "bigint") throw new SnowbridgeReadError(`${what} is not an amount`);
  return value;
}

/** What `chain` charges for the weight of `program`, in `asset`. */
async function priceOf(
  chain: ChainReader,
  program: XcmInstruction[],
  asset: unknown,
  what: string,
): Promise<bigint> {
  const weight = granted(
    await chain.call("XcmPaymentApi", "query_xcm_weight", versioned(program)),
    `the weight of ${what}`,
  );
  const fee = await chain.call(
    "XcmPaymentApi",
    "query_weight_to_asset_fee",
    weight,
    versioned(asset),
  );
  return amount(granted(fee, `the price of ${what}`), `the price of ${what}`);
}

/** The DOT `chain` charges to deliver `program` to the sibling `toPara`. */
async function deliveryDot(
  chain: ChainReader,
  toPara: number,
  program: XcmInstruction[],
  what: string,
): Promise<bigint> {
  const reply = await chain.call(
    "XcmPaymentApi",
    "query_delivery_fees",
    versioned(sibling(toPara)),
    versioned(program),
    versioned(DOT),
  );
  const assets = granted(reply, what);
  const list = isRecord(assets) && Array.isArray(assets.value) ? assets.value : [];
  const first: unknown = list[0];
  const fun = list.length === 1 && isRecord(first) && isRecord(first.fun) ? first.fun : {};
  if (fun.type !== "Fungible") throw new SnowbridgeReadError(`${what} is not one amount`);
  return amount(fun.value, what);
}

/** The ether Asset Hub's pool takes to pay `dot` of DOT. This is the swap Asset Hub itself makes
 *  when a message pays a fee in ether. */
async function etherFor(assetHub: ChainReader, dot: bigint, what: string): Promise<bigint> {
  const quote = await assetHub.call(
    "AssetConversionApi",
    "quote_price_tokens_for_exact_tokens",
    ETHER,
    DOT,
    dot,
    true,
  );
  if (typeof quote !== "bigint") {
    throw new SnowbridgeReadError(`the pool gave no price for ${what}`);
  }
  return quote;
}

function mustComplete(run: XcmDryRun, chain: string): void {
  if (run.failure !== null) {
    throw new SnowbridgeReadError(
      `the trial stops on ${chain} at instruction ${run.failure.index} with ${run.failure.error}`,
    );
  }
}

function mustForward(run: XcmDryRun, toPara: number, chain: string): XcmInstruction[] {
  const forwarded = run.forwardedTo(toPara);
  if (forwarded === null) throw new SnowbridgeReadError(`${chain} sends the trial nowhere`);
  return forwarded;
}

/** Runs `trial` through the three hops in dry runs and reads what each chain charges. The fees of
 *  `trial` must be far above the real ones, and its amounts near the real ones in size, because
 *  a delivery is priced by the bytes of the message. */
export async function readSnowbridgeCosts(
  chains: SnowbridgeChains,
  trial: SnowbridgeMessage,
): Promise<SnowbridgeTrial> {
  const { assetHub, bridgeHub, hydration } = chains;
  const delivered = deliveredProgram(trial);

  const [ether, assetHubExecution, bridgeHubDot, first] = await Promise.all([
    assetHub.storage("ForeignAssets", "Asset", ETHER),
    priceOf(assetHub, delivered, ETHER, "the message on Asset Hub"),
    deliveryDot(bridgeHub, ASSET_HUB, delivered, "Bridge Hub's delivery"),
    dryRunXcm(assetHub, BRIDGE_HUB, delivered),
  ]);
  if (!isRecord(ether)) throw new SnowbridgeReadError("Asset Hub does not know ether");
  const etherMinimum = amount(ether.min_balance, "the minimum balance of ether");
  mustComplete(first, "Asset Hub");
  const toHydration = mustForward(first, HYDRATION, "Asset Hub");

  const [hydrationDot, hydrationExecution, second] = await Promise.all([
    deliveryDot(assetHub, HYDRATION, toHydration, "the delivery to Hydration"),
    priceOf(hydration, toHydration, ETHER, "the program on Hydration"),
    dryRunXcm(hydration, ASSET_HUB, toHydration),
  ]);
  mustComplete(second, "Hydration");
  const back = mustForward(second, ASSET_HUB, "Hydration");
  const swap = second.events.find(
    (event) =>
      event.pallet === "Router" &&
      event.name === "Executed" &&
      event.fields.asset_in === ETHER_ON_HYDRATION &&
      event.fields.asset_out === USDT_ON_HYDRATION,
  );
  if (swap === undefined) throw new SnowbridgeReadError("Hydration made no swap in the trial");

  // The ether that comes back from a failed swap runs the same instructions as the USDT, so the
  // deposit of the USDT is priced in both.
  const [hydrationDelivery, bridgeHubDelivery, relayerTransaction, depositUsdt, depositEther] =
    await Promise.all([
      etherFor(assetHub, hydrationDot, "the delivery to Hydration"),
      etherFor(assetHub, bridgeHubDot, "Bridge Hub's delivery"),
      etherFor(assetHub, RELAYER_TRANSACTION_DOT, "the relayer's transaction"),
      priceOf(assetHub, back, USDT, "the deposit in USDT"),
      priceOf(assetHub, back, ETHER, "the deposit in ether"),
    ]);

  return {
    costs: {
      assetHubExecution,
      hydrationDelivery,
      hydrationExecution,
      depositUsdt,
      depositEther,
      etherMinimum,
      bridgeHubDelivery,
      relayerTransaction,
    },
    usdtOut: amount(swap.fields.amount_out, "the USDT of the swap"),
  };
}
