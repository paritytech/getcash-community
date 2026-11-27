// Hosted seams of a withdrawal: the disposable key the purse pays, the purse's payment to it, the
// key's CASH on People, and the hand-off to the worker. The chain legs run in the product's
// worker, and so does the payment call, since the worker is the host's payment client for the
// top-up claims already; this page hands the request over and reads it back, as coinage-live
// does for the on-ramp.

import { PaymentRequestErr, PaymentStatusErr } from "@novasamatech/host-api";
import { deriveEntropy, getHostLocalStorage } from "@parity/product-sdk-host";
import type { TokenSpec } from "@getsome/core";
import { deriveKeypair } from "@getsome/ephemeral";
import {
  chooseCashTransfer,
  chooseRoute,
  depositTokenOf,
  NoCashTransferError,
  PASEO_ASSET_HUB_PARA_ID,
  PASEO_PEOPLE_PARA_ID,
  STABLE_TOKENS,
  type ConversionRoute,
  type DepositAsset,
  type PsmRoute,
  type RouteQuery,
} from "@getsome/funding";
import { sellAmountOf } from "@getsome/meld";
import {
  createHostEntropyPort,
  createHostStorageAdapter,
  type HostLocalStorageLike,
} from "@getsome/host";
import { CASH_LOCATION } from "@getsome/people";
import {
  buildRedeemBatch,
  CASH_ON_ASSET_HUB,
  DEFAULT_WITHDRAW_SLIPPAGE_PCT,
  estimateDirectFeesCash,
  estimateRedeemFeeCash,
  exactPaymentFloor,
  PASEO_PEOPLE_POOL_ACCOUNT,
  PEOPLE_NATIVE,
  readRedeemFloors,
  redeemAmountOf,
  RedeemTooSmallError,
  residueReturnFloor,
  sizeRedeem,
  type AssetHubApi,
} from "@getsome/withdraw";
import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import {
  WITHDRAW_SOURCE_PREFIX,
  handoffSaleOf,
  isWithdrawSourceId,
  type HostPaymentStatus,
  type PaymentRefusal,
  type WithdrawalChannel,
  type WithdrawalHandoffPayload,
} from "../app/funding/requests/model";
import { isDemoBuild } from "../app/utils/demo";
import { ADAPTER_AUTH, PRODUCT_ID } from "./adapter-fetch";
import { hostSafeEntropy, nextFreeTradeNumber, readTradeCounter, tradeCounterKey } from "./coinage";
import {
  requestPayment as hostRequestPayment,
  subscribePaymentStatus,
  type PaymentStatus,
  type StatusSubscription,
} from "./host-payments";
import { ASSET_HUB_GENESIS, PEOPLE_GENESIS } from "./host-chain";
import { devLog } from "./log";

/** How long to wait for the worker to come up before a hand-off fails. */
const WORKER_READY_MS = 20_000;
/** Bound on the worker's answer to a payment status read: its own host read is bounded under it. */
const PAYMENT_STATUS_DEADLINE_MS = 15_000;

const toHex = (bytes: Uint8Array): `0x${string}` =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

/** The entropy label of withdrawal `n` under `sourceId`, at most 32 bytes, the host's key limit.
 *  The worker builds the same bytes from the string it is handed. */
export function withdrawEntropyLabel(sourceId: string, n: number): string {
  if (!isWithdrawSourceId(sourceId)) throw new Error(`'${sourceId}' is not a withdrawal source`);
  return `wd:eph:${sourceId.slice(WITHDRAW_SOURCE_PREFIX.length)}:${n}`;
}

export interface WithdrawKey {
  /** The key's People address. */
  address: string;
  publicKeyHex: `0x${string}`;
}

/** Withdrawal `n`'s key, derived from the host's entropy root. */
export async function withdrawKeyFor(sourceId: string, n: number): Promise<WithdrawKey> {
  const entropy = createHostEntropyPort(hostSafeEntropy(deriveEntropy));
  const seed = await entropy.deriveSeed(
    new TextEncoder().encode(withdrawEntropyLabel(sourceId, n)),
  );
  const keypair = deriveKeypair(seed);
  return { address: keypair.address, publicKeyHex: toHex(keypair.publicKey) };
}

/** The key's CASH on People at the best block. */
export async function probeWithdrawKey(
  sourceId: string,
  n: number,
): Promise<{ address: string; cash: bigint }> {
  const { address } = await withdrawKeyFor(sourceId, n);
  const { connectChain, PEOPLE } = await import("./host-chain");
  const api = (await connectChain(PEOPLE)).getTypedApi(paseo_people_next);
  const account = await api.query.Assets.Account.getValue(CASH_LOCATION as never, address, {
    at: "best",
  });
  return { address, cash: account?.balance ?? 0n };
}

/** Whether this network lets CASH move from People to Asset Hub. False only when the chains say
 *  so; a read that fails answers true, since the worker asks again before it moves anything. */
export async function cashCanMove(): Promise<boolean> {
  try {
    const { connectChain, ASSET_HUB, PEOPLE } = await import("./host-chain");
    const [assetHub, people] = await Promise.all([connectChain(ASSET_HUB), connectChain(PEOPLE)]);
    await chooseCashTransfer({
      assetHub,
      people,
      assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
      peopleParaId: PASEO_PEOPLE_PARA_ID,
    });
    return true;
  } catch (e) {
    if (e instanceof NoCashTransferError) return false;
    devLog("withdraw", "the CASH transfer could not be read (the worker asks again)", e, "warn");
    return true;
  }
}

/** How long a fee estimate serves before People is read again. */
const FEES_FRESH_MS = 60_000;
const feesBySale = new Map<string, { at: number; fees: Promise<bigint> }>();

/** The sales one quote serves, as a key: a pool sale fed through a stable has a hop more than one
 *  for the native, and the PSM lands its own figure, so each is kept apart from the others. */
const saleKeyOf = (sale: ConversionRoute): string =>
  sale.tier === "dotusd" ? sale.tier : `${sale.tier}:${sale.external ?? "native"}`;

/** The CASH the fees take from a direct withdrawal before the sale on Asset Hub, priced now on
 *  People and kept for a minute: the swap that buys the fee PAS, its own fee and Asset Hub's
 *  buffer, as the worker will size them. An estimate for the summary, on the safe side. */
export async function directFeesCash(sale: ConversionRoute): Promise<bigint> {
  const key = saleKeyOf(sale);
  const cached = feesBySale.get(key);
  if (cached !== undefined && Date.now() - cached.at < FEES_FRESH_MS) return cached.fees;
  const fees = (async () => {
    const { connectChain, ASSET_HUB, PEOPLE } = await import("./host-chain");
    const [assetHub, people] = await Promise.all([connectChain(ASSET_HUB), connectChain(PEOPLE)]);
    // Priced on the XCM the worker will send, which the chains' trust shapes.
    const transfer = await chooseCashTransfer({
      assetHub,
      people,
      assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
      peopleParaId: PASEO_PEOPLE_PARA_ID,
    });
    return estimateDirectFeesCash({
      peopleApi: people.getTypedApi(paseo_people_next),
      address: PASEO_PEOPLE_POOL_ACCOUNT,
      poolAccount: PASEO_PEOPLE_POOL_ACCOUNT,
      assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
      peopleParaId: PASEO_PEOPLE_PARA_ID,
      sale,
      transfer,
    });
  })();
  feesBySale.set(key, { at: Date.now(), fees });
  // A read that failed is not kept; the next quote asks again.
  fees.catch(() => feesBySale.delete(key));
  return fees;
}

/** The sale a direct withdrawal of `amount` CASH makes for the token it lands, decided the way
 *  the on-ramp decides a deposit's tier the other way round: the native takes the pool and
 *  dotUSD the teleport, with no chain read; a stable takes the PSM when it is approved for
 *  redeeming, can serve the amount and the redeem clears its floors (`redeemFits`), the pool fed
 *  through the native otherwise. `reserved` is the CASH this app's own in-flight PSM withdrawals
 *  have yet to redeem, which the PSM's room is judged without. */
export async function chooseWithdrawRoute(
  amount: bigint,
  landing: DepositAsset,
  reserved: bigint,
): Promise<ConversionRoute> {
  if (landing === "native") return { tier: "pool" };
  if (landing === "dotUSD") return { tier: "dotusd" };
  const { api, query } = await withdrawRouteQuery(amount, reserved);
  const route = await chooseRoute(api, { ...query, deposit: landing });
  if (route.tier !== "psm" || (await redeemFits(api, amount, route))) return route;
  return { tier: "pool", external: landing };
}

/** The Asset Hub a withdrawal's sale is decided on, and the redeem it is judged on: what the
 *  redeem will take, the amount less the fees and Asset Hub's earmark. */
async function withdrawRouteQuery(
  amount: bigint,
  reserved: bigint,
): Promise<{ api: AssetHubApi; query: RouteQuery }> {
  const { connectChain, ASSET_HUB } = await import("./host-chain");
  const api = (await connectChain(ASSET_HUB)).getTypedApi(paseo_next_v2);
  const sold = amount - (await directFeesCash({ tier: "pool" }));
  return { api, query: { direction: "redeem", internalAmount: redeemAmountOf(sold), reserved } };
}

/** Stands in for the key and the provider in a fee estimate before either is known: the fee
 *  depends on the call, not on who makes it. */
const FEE_ESTIMATE_ACCOUNT = "13ENScfFZXQ8avXf6cphack516B8YCjdL4MJbodm7VxK8GE9";

/** How many times today's fee estimates a PSM pick must survive: the redeem is sized as if the
 *  fees came to this much, so fees that rise before it runs cannot leave it under a floor the
 *  worker would then refuse it at. Only an amount near the PSM's minimum is turned away by it. */
const REDEEM_FEE_DRIFT = 2n;

/** The redeem of `sold` CASH reaching the key, sized as the worker sizes it (`sizeRedeem`): the
 *  batch's own fee with its margin and the CASH account's minimum stay on the key, the rest is
 *  redeemed at the frozen rate, held to the PSM's minimum and the stable's. The redeem alone is
 *  priced, as a provider rail runs it, and its fee taken `feeTimes` over for a pick's margin.
 *  Null when the chain would refuse it. */
async function redeemNow(
  api: AssetHubApi,
  sold: bigint,
  sale: PsmRoute,
  feeTimes = 1n,
): Promise<{ cashIn: bigint; net: bigint } | null> {
  if (sold <= 0n) return null;
  const [floors, feeCash] = await Promise.all([
    readRedeemFloors(api, sale),
    estimateRedeemFeeCash(
      api,
      buildRedeemBatch(api, { route: sale, cashIn: sold }),
      FEE_ESTIMATE_ACCOUNT,
    ),
  ]);
  try {
    return sizeRedeem(sold, feeCash * feeTimes, sale, floors);
  } catch (e) {
    if (e instanceof RedeemTooSmallError) return null;
    throw e;
  }
}

/** Whether a withdrawal of `amount` CASH can take the PSM `sale`: the redeem it makes clears the
 *  chain's floors with every fee at REDEEM_FEE_DRIFT times today's estimate. */
async function redeemFits(api: AssetHubApi, amount: bigint, sale: PsmRoute): Promise<boolean> {
  const fees = await directFeesCash(sale);
  const sold = amount - fees * REDEEM_FEE_DRIFT;
  return (await redeemNow(api, sold, sale, REDEEM_FEE_DRIFT)) !== null;
}

/** What a direct withdrawal of `amount` CASH lands on Asset Hub in the asset `sale` ends in,
 *  base units, at today's prices: the amount less the fees, sold as the program sells it,
 *  redeemed as the batch redeems it from the key, or landed as it is on the dotUSD tier. An
 *  estimate for the summary, not what the program is held to. */
export async function quoteDirectReceive(amount: bigint, sale: ConversionRoute): Promise<bigint> {
  const sold = amount - (await directFeesCash(sale));
  if (sold <= 0n) return 0n;
  if (sale.tier === "dotusd") return sold;
  const { connectChain, ASSET_HUB } = await import("./host-chain");
  const api = (await connectChain(ASSET_HUB)).getTypedApi(paseo_next_v2);
  if (sale.tier === "psm") return (await redeemNow(api, sold, sale))?.net ?? 0n;
  const native = await api.apis.AssetConversionApi.quote_price_exact_tokens_for_tokens(
    CASH_ON_ASSET_HUB as never,
    PEOPLE_NATIVE as never,
    sold,
    true,
  );
  if (native === undefined) throw new Error("Asset Hub cannot quote the sale");
  if (sale.external === undefined) return native;
  const stable = await api.apis.AssetConversionApi.quote_price_exact_tokens_for_tokens(
    PEOPLE_NATIVE as never,
    STABLE_TOKENS[sale.external].location as never,
    native,
    true,
  );
  if (stable === undefined) throw new Error(`Asset Hub cannot quote the ${sale.external} sale`);
  return stable;
}

// A fiat sale promises its provider an exact figure before the seller's KYC and pays it after, out
// of a sale on Asset Hub that only runs then. On the pool tier that sale is held to the program's
// floor of DEFAULT_WITHDRAW_SLIPPAGE_PCT below the quote of its moment, so the figure is what the
// sale lands today less that floor, less the margin the check before the purse keeps, less a point
// for the price to move while the seller verifies, less what the payment itself costs the key. On
// the PSM tier the rate is frozen on the sale, so the figure is what the batch pays out of what
// the key holds, less the payment's cost and nothing else. What the sale lands above the figure is
// the residue, which the worker sends home once the provider is paid. Before the purse is asked
// the figure is checked again, on the pool tier with that margin under the floor, since the worker
// sizes the sale a few minutes later, and on the PSM tier with the pair decided again as it stands,
// since the seller's verification can take hours; a price that moved too far meanwhile, or a PSM
// that can no longer serve the sale, ends it with nothing taken.

/** Room the check before the purse keeps under the worker's floor, percent: the worker sizes the
 *  sale minutes later, after the purse pays and the fee swap runs. */
const PURSE_CHECK_MARGIN_PCT = 0.5;
/** Room for the price to move while the seller verifies with the provider, percent. */
const SALE_KYC_MARGIN_PCT = 1;

/** The least `sale` lands of `expected`, in its token, as the worker will hold it: the program's
 *  floor of `slippagePct` under it on the pool tiers, with `marginPct` more under that; the figure
 *  itself on the PSM tier, whose rate is frozen on the sale. */
function saleFloor(
  expected: bigint,
  sale: ConversionRoute,
  marginPct: number,
  slippagePct: number = DEFAULT_WITHDRAW_SLIPPAGE_PCT,
): bigint {
  if (sale.tier === "psm") return expected;
  const keptPct = BigInt(Math.round((100 - slippagePct - marginPct) * 100));
  return (expected * keptPct) / 10_000n;
}

/** What `sale` lands of `amount` CASH today in its token, as the worker will size it, the fees it
 *  takes first and the Asset Hub it was read on; null when the fees take the whole amount. The
 *  summary's own figure: the pool tiers land the quote for everything the fees leave, the PSM
 *  what the batch redeems of it from the key. */
async function saleNow(amount: bigint, sale: ConversionRoute) {
  const fees = await directFeesCash(sale);
  const sold = amount - fees;
  if (sold <= 0n) return null;
  const { connectChain, ASSET_HUB } = await import("./host-chain");
  const api = (await connectChain(ASSET_HUB)).getTypedApi(paseo_next_v2);
  const expected = await quoteDirectReceive(amount, sale);
  return { api, fees, expected };
}

/** What a sale of some CASH promises its provider, and what it is expected to send back. */
export interface MeldSaleSize {
  /** Exactly what the key pays the provider, in the sale's token, cut to the sale's decimals. */
  planck: bigint;
  /** The CASH expected back once the provider is paid: the share of the sale the figure and the
   *  payment do not use, at today's price and before the way back's own fees. 0 when that share is
   *  too small to send back, and stays with the withdrawal. */
  backCash: bigint;
}

/** What paying `amount` of `token` out of the key costs beyond the amount, as the worker holds
 *  the sale to it: the transfer's fee with its headroom and what the key keeps to stay alive. */
async function paymentCost(api: AssetHubApi, amount: bigint, token: TokenSpec): Promise<bigint> {
  const floor = await exactPaymentFloor(
    api,
    FEE_ESTIMATE_ACCOUNT,
    FEE_ESTIMATE_ACCOUNT,
    amount,
    token,
  );
  return floor - amount;
}

/** The figure a sale of `amount` CASH through `sale` promises its provider, in the sale's token,
 *  and what it should send back. Throws when nothing is left for the figure. */
export async function sizeMeldCommitment(
  amount: bigint,
  sale: ConversionRoute,
): Promise<MeldSaleSize> {
  const now = await saleNow(amount, sale);
  if (now === null) throw new Error("The amount does not cover the network fees.");
  const token = depositTokenOf(sale);
  const cost = await paymentCost(now.api, now.expected, token);
  const planck = sellAmountOf(
    saleFloor(now.expected, sale, PURSE_CHECK_MARGIN_PCT + SALE_KYC_MARGIN_PCT) - cost,
    token,
  );
  if (planck <= 0n) throw new Error("The amount does not cover the network fees.");
  // The worker sends home what the key holds once the provider is paid, as it judges it then.
  const left = now.expected - planck - cost;
  const backCash =
    left < residueReturnFloor(token) ? 0n : ((amount - now.fees) * left) / now.expected;
  return { planck, backCash };
}

/** Whether `amount` CASH through `sale` still covers a sale's `planck` at today's price: the floor
 *  the worker would ship covers the payment to `depositAddress`, its fee and what the key keeps to
 *  stay alive, as the worker itself will require. On the PSM tier the sale is decided again first,
 *  with `reserved` of the pair's room spoken for by this app's other redeems: a pair that filled
 *  up, stopped or repriced since the quote cannot run the worker's redeem at the frozen rate.
 *  Asked before the purse is, at the `slippagePct` the sale's hand-off holds the worker to, which
 *  a sale started before a change of the default keeps. */
export async function meldCommitmentFundable(
  amount: bigint,
  planck: bigint,
  depositAddress: string,
  sale: ConversionRoute,
  reserved: bigint,
  slippagePct: number = DEFAULT_WITHDRAW_SLIPPAGE_PCT,
): Promise<boolean> {
  if (sale.tier === "psm") {
    const today = await chooseWithdrawRoute(amount, sale.external, reserved);
    if (
      today.tier !== "psm" ||
      today.external !== sale.external ||
      today.feeRate !== sale.feeRate
    ) {
      return false;
    }
  }
  const now = await saleNow(amount, sale);
  if (now === null) return false;
  const needed = await exactPaymentFloor(
    now.api,
    FEE_ESTIMATE_ACCOUNT,
    depositAddress,
    planck,
    depositTokenOf(sale),
  );
  return saleFloor(now.expected, sale, PURSE_CHECK_MARGIN_PCT, slippagePct) >= needed;
}

/** Where the worker reads a fiat sale from: the adapter this build names, or the stand-in sale in
 *  a demo build that names none. Null in any other build: the worker trusts a stand-in sale as the
 *  hand-off describes it, and its deposit address is made up. */
export function meldHandoffConfig(): NonNullable<WithdrawalHandoffPayload["meld"]> | null {
  const baseUrl = import.meta.env.VITE_MELD_BASE_URL as string | undefined;
  if (!baseUrl) return isDemoBuild() ? { offline: true } : null;
  return { baseUrl, productId: PRODUCT_ID, auth: ADAPTER_AUTH };
}

async function hostStorageAdapter() {
  const storage = await getHostLocalStorage();
  if (!storage) throw new Error("host storage unavailable (not running inside the Polkadot App?)");
  return createHostStorageAdapter(storage as HostLocalStorageLike);
}

/** The source's counter in the host store: the number the next withdrawal takes. */
export async function readWithdrawCounter(sourceId: string): Promise<number> {
  return readTradeCounter(await hostStorageAdapter(), sourceId);
}

/** The number the next withdrawal under `sourceId` takes: the counter, moved past every number
 *  `hasTrace` still knows of. */
export async function nextWithdrawNumber(
  sourceId: string,
  hasTrace: (n: number) => Promise<boolean>,
): Promise<number> {
  return nextFreeTradeNumber(await hostStorageAdapter(), sourceId, hasTrace);
}

/** Claims number `n` for good: the next withdrawal under `sourceId` derives a fresh key. A
 *  failed write is warned about; the next start searches past the taken number anyway. */
export async function advanceWithdrawCounter(sourceId: string, n: number): Promise<void> {
  try {
    await (await hostStorageAdapter()).write(tradeCounterKey(sourceId), String(n + 1));
  } catch (e) {
    devLog(
      "withdraw",
      `counter advance for ${sourceId} failed (the next start searches past it)`,
      e,
      "warn",
    );
  }
}

/** The account Asset Hub maps an H160 to, asked of its runtime at the best block. */
export async function readH160Account(h160: `0x${string}`): Promise<string> {
  const { connectChain, ASSET_HUB } = await import("./host-chain");
  const api = (await connectChain(ASSET_HUB)).getTypedApi(paseo_next_v2);
  return api.apis.ReviveApi.account_id(h160, { at: "best" });
}

/** The hand-off for a withdrawal, with the chain facts this build is made for. The sale rides
 *  on it the way the on-ramp's tier does. */
export function withdrawHandoff(args: {
  sourceId: string;
  n: number;
  key: WithdrawKey;
  amount: bigint;
  destination: WithdrawalHandoffPayload["destination"];
  landingHex: string;
  rail: WithdrawalHandoffPayload["rail"];
  sale: ConversionRoute;
  paymentExpiresAt: number;
  channel?: WithdrawalChannel;
  meld?: WithdrawalHandoffPayload["meld"];
}): WithdrawalHandoffPayload {
  return {
    ...(args.channel === undefined ? {} : { channel: args.channel }),
    ...(args.meld === undefined ? {} : { meld: args.meld }),
    label: withdrawEntropyLabel(args.sourceId, args.n),
    keyAddress: args.key.address,
    keyPublicKeyHex: args.key.publicKeyHex,
    amount: args.amount.toString(),
    destination: args.destination,
    landingHex: args.landingHex,
    rail: args.rail,
    ...handoffSaleOf(args.sale),
    assetHubGenesis: ASSET_HUB_GENESIS,
    peopleGenesis: PEOPLE_GENESIS,
    peopleParaId: PASEO_PEOPLE_PARA_ID,
    assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
    poolAccount: PASEO_PEOPLE_POOL_ACCOUNT,
    slippagePct: DEFAULT_WITHDRAW_SLIPPAGE_PCT,
    paymentExpiresAt: args.paymentExpiresAt,
  };
}

interface WorkerLike {
  isAvailable(): boolean;
  call<T>(apiName: string, payload?: unknown, options?: { deadlineMs?: number }): Promise<T>;
}

/** Waits for the worker's heartbeat up to `WORKER_READY_MS`; throws when it never comes. */
async function awaitWorker(worker: WorkerLike, what: string): Promise<void> {
  const readyBy = Date.now() + WORKER_READY_MS;
  while (!worker.isAvailable() && Date.now() < readyBy) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!worker.isAvailable()) {
    throw new Error(`the funding worker is not running on this host; ${what}`);
  }
}

/** Hands one withdrawal to the worker: waits for its heartbeat, then sends `startWithdraw`.
 *  Idempotent on the session id; a refusal throws and no job exists. */
export async function sendWithdrawHandoff(
  worker: WorkerLike,
  sessionId: string,
  payload: WithdrawalHandoffPayload,
): Promise<void> {
  await awaitWorker(worker, "the withdrawal cannot start");
  await worker.call("startWithdraw", { sessionId, ...payload });
}

/** Tells the worker a withdrawal still waiting for its payment was cancelled. */
export function cancelWithdrawJob(worker: WorkerLike, sessionId: string): Promise<unknown> {
  return worker.call("cancelWithdraw", { sessionId });
}

/** Dev builds only: tells the worker to take a withdrawal's sale as delivered. On a test network
 *  the provider never pays out, so the walk ends here by hand. */
export function skipWithdrawRail(worker: WorkerLike, sessionId: string): Promise<unknown> {
  return worker.call("skipWithdrawRail", { sessionId });
}

/** Tells the worker to sell a held withdrawal's CASH on the pool instead of redeeming it: the
 *  job's exit changes and the job is re-armed; its sale stays as the hand-off froze it. The worker
 *  refuses a job that is not held. */
export function switchWithdrawToPool(worker: WorkerLike, sessionId: string): Promise<unknown> {
  return worker.call("switchWithdrawToPool", { sessionId });
}

/** Nudges the worker into a pass over its withdrawals. A run has stalled between wakes while the
 *  page was up, so each poll round drives a pass, as the top-up's loop does. Detached: a tick can
 *  take tens of seconds and the poll does not wait on it. A worker that is not up is left alone. */
export function nudgeWithdrawTicks(worker: WorkerLike): void {
  if (!worker.isAvailable()) return;
  void worker.call("tickAllWithdraw").catch(() => {});
}

// The purse's payment to a withdrawal key is requested from the page, not the worker: the host
// shows its sheets, the approval and the privacy consent, to a page and to nothing else. The
// worker only watches the key the purse pays. The page SDK cannot make the request (its payment
// codec predates the id), so it goes over the host protocol client in host-payments, which shares
// the SDK's channel.

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.slice(2).match(/.{2}/g) ?? [], (byte) => parseInt(byte, 16));

/** The host refused a payment request; the message is the user's reason, and the refusal says
 *  which kind it was. */
export class PaymentRefusedError extends Error {
  constructor(
    message: string,
    readonly refusal: PaymentRefusal = "other",
  ) {
    super(message);
    this.name = "PaymentRefusedError";
  }
}

/** What the host's refusal means to the user, and which kind it was. */
function refusalOf(error: unknown): { message: string; refusal: PaymentRefusal } {
  if (error instanceof PaymentRequestErr.Rejected) {
    return { message: "The payment was declined.", refusal: "declined" };
  }
  if (error instanceof PaymentRequestErr.InsufficientBalance) {
    return {
      message: "The balance does not cover this withdrawal.",
      refusal: "insufficient-balance",
    };
  }
  return { message: error instanceof Error ? error.message : String(error), refusal: "other" };
}

/** Asks the host to pay `amount` CASH to the key under `idHex`. Resolves once the host registered
 *  the payment, which is after the user's decision on its sheets, so a caller starts it and reads
 *  the answer back through the status. Idempotent on the id: a known id resolves at once and
 *  raises no second sheet. Throws PaymentRefusedError with the user's reason when the host
 *  refused. */
export async function requestKeyPayment(args: {
  idHex: string;
  amount: bigint;
  key: WithdrawKey;
}): Promise<void> {
  try {
    await hostRequestPayment(args.amount, fromHex(args.key.publicKeyHex), fromHex(args.idHex));
  } catch (error) {
    if (error instanceof PaymentRequestErr.AlreadyExists) return;
    const { message, refusal } = refusalOf(error);
    throw new PaymentRefusedError(message, refusal);
  }
}

export interface PaymentStatusReading {
  status: HostPaymentStatus;
  reason?: string;
  /** Base units, when the host paid short. */
  actualClaimed?: string;
}

/** The first value of a host status subscription within `timeoutMs`; the subscription is closed
 *  right after. An interrupt before the first value rejects with the host's error. */
function firstStatus<T>(
  subscribe: (callback: (status: T) => void) => StatusSubscription,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let subscription: StatusSubscription | null = null;
    let done = false;
    const finish = (): void => {
      done = true;
      clearTimeout(timer);
      subscription?.unsubscribe();
    };
    const timer = setTimeout(() => {
      if (done) return;
      finish();
      reject(new Error(`payment status read timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    subscription = subscribe((status) => {
      if (done) return;
      finish();
      resolve(status);
    });
    subscription.onInterrupt((error) => {
      if (done) return;
      finish();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    if (done) subscription.unsubscribe();
  });
}

/** One read of the host's word on payment `idHex`: its status when it has one, `not-found` for an
 *  id it does not know yet. Throws when the host could not be asked. */
export async function readPaymentStatus(idHex: string): Promise<PaymentStatusReading> {
  let status: PaymentStatus;
  try {
    status = await firstStatus<PaymentStatus>(
      (callback) => subscribePaymentStatus(fromHex(idHex), callback),
      PAYMENT_STATUS_DEADLINE_MS,
    );
  } catch (error) {
    if (error instanceof PaymentStatusErr.PaymentNotFound) return { status: "not-found" };
    throw error;
  }
  switch (status.type) {
    case "processing":
    case "completed":
      return { status: status.type };
    case "failed":
      return { status: "failed", reason: status.reason };
    case "partiallyClaimed":
      return { status: "partiallyClaimed", actualClaimed: status.actualClaimed.toString() };
  }
}
