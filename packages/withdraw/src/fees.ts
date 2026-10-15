// Sizes the two withdrawal transactions and proves the XCM on both chains before it is signed.
//
// The swap is sized from the pool's reserves, read from the pool account because People exposes
// no quoting runtime api, with the pallet's own formulas. It buys People's existential deposit in
// PAS, the least the pool will sell and well above the fees measured on Paseo, and may spend a
// little more CASH than the quote; the remainder leaves with the XCM anyway.
//
// The XCM is sized from what the key holds after the swap. People's fee runtime calls cannot price
// it, so the sizing measures: a first dry run pays People's XCM fees with all the PAS the key has
// and reads what was left over as trapped; the difference is what People charges. The delivery
// part of that charge depends on the message People forwards, which changes once the leftover PAS
// travels along, so the delivery fee is quoted again on a stand-in of the final message. A last
// dry run confirms the exact allowance: the program completes and traps nothing. Asset Hub then
// runs the forwarded program and what it credits the destination, in the asset the sale lands,
// is read back.
//
// The XCM's transaction fee is paid in PAS and estimated with a margin. People withdraws a fee
// while keeping the account alive, so the key must hold the existential deposit on top of the
// fee when the XCM is signed; the swap buys both. A dry run charges no fee, so the withdrawn PAS
// is what the key holds less the reserve; what the reserve leaves unspent is below the
// existential deposit and the chain reaps it with the account.

import { paseo_next_v2 } from "@polkadot-api/descriptors";
import { AccountId, type TypedApi } from "polkadot-api";
import { CASH_LOCATION } from "@getsome/people";
import {
  ADVERSE_FLOW_MULTIPLE,
  creditedTo,
  DEFAULT_LP_FEE_PPM,
  depositTokenOf,
  describeDispatchError,
  destinationEarmark,
  forwardedTo,
  siblingOrigin,
  signedOrigin,
  slippageFor,
  STABLE_TOKENS,
  trappedIn,
  withdrawalBounds,
  xcmErrorName,
  type CashTransfer,
  type ConversionRoute,
} from "@getsome/funding";
import { PEOPLE_NATIVE, PEOPLE_TX_OPTIONS } from "./paseo";
import { cashInFor, type PoolReserves } from "./pool";
import {
  buildSwap,
  buildWithdrawXcm,
  CASH_ON_ASSET_HUB,
  forwardedStandIn,
  originOnAssetHub,
  psmRedeemOut,
  withdrawMessage,
  type PeopleApi,
  type Sale,
  type SwapArgs,
  type WithdrawXcmArgs,
} from "./program";

export type AssetHubApi = TypedApi<typeof paseo_next_v2>;

/** CASH set aside for Asset Hub's execution fee, above the one percent floor. The pool programs
 *  measure a few thousand units and the PSM one about eight thousand, priced through the pool,
 *  so this leaves room for the price to move; the unused part is refunded into the sale. */
export const ASSET_HUB_FEE_BUFFER_CASH = 30_000n;

/** A typical withdrawal, in CASH: the size of other people's sales the bound has to survive. */
export const TYPICAL_WITHDRAWAL_CASH = 100_000_000n;

/** The fee swap's least headroom, percent. The swap is exact-out, so a wide limit costs nothing,
 *  while a rejected swap burns a CASH fee and one of the three strikes it shares with the XCM. */
export const SWAP_HEADROOM_PCT = 5;

/** The fee swap's headroom for these reserves, percent: at least SWAP_HEADROOM_PCT, at most the
 *  cap, which a pool too thin to price the trade gets. */
export function swapHeadroomPct(reserves: PoolReserves, pasOut: bigint): number {
  const decision = slippageFor({
    reserves: { in: reserves.cash, out: reserves.pas },
    tradeOut: pasOut,
    exposure: "instant",
    // The competing flow is other withdrawals buying their own fees.
    referenceTrade: pasOut,
    competingTrade: pasOut,
    adverseFlowMultiple: ADVERSE_FLOW_MULTIPLE.instant * 2,
    floorPct: SWAP_HEADROOM_PCT,
  });
  return decision.pct;
}

/** The key's CASH cannot buy the PAS the fees need. Named so the worker can fail the job once the
 *  whole payment is on the key, instead of retrying. */
export class WithdrawUnderfundedError extends Error {
  constructor(
    readonly cashBalance: bigint,
    readonly pasNeeded: bigint,
  ) {
    super(`withdraw sizing: ${cashBalance} CASH cannot buy the ${pasNeeded} PAS the fees need`);
    this.name = "WithdrawUnderfundedError";
  }
}

/** Headroom on the XCM's transaction fee estimate, percent. The unspent part is reaped dust. */
export const XCM_TX_FEE_HEADROOM_PCT = 5;

/** Rounds of measure and confirm before the sizing gives up on an exact People allowance. */
const FEE_ROUNDS = 3;

/** An amount whose compact encoding is the longest any amount below 2^64 gets: nine bytes. */
const LONGEST_AMOUNT = 2n ** 63n;

/** More bytes than the redeem call encodes to, for the fee estimate on the call's length. */
const LONGEST_CALL = new Uint8Array(64);

const toHex = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

/** The key needs more PAS than it holds to send the XCM: swap again. */
export class NeedsSwapError extends Error {
  constructor(
    readonly pasOnKey: bigint,
    readonly pasNeeded: bigint,
  ) {
    super(`withdraw sizing: the key holds ${pasOnKey} PAS and the XCM needs ${pasNeeded}`);
    this.name = "NeedsSwapError";
  }
}

/** The pool reserves: the pool account's balances of both assets. */
export async function readPoolReserves(
  peopleApi: PeopleApi,
  poolAccount: string,
): Promise<PoolReserves> {
  const [native, asset] = await Promise.all([
    peopleApi.query.System.Account.getValue(poolAccount),
    peopleApi.query.Assets.Account.getValue(CASH_LOCATION as never, poolAccount),
  ]);
  return { cash: asset?.balance ?? 0n, pas: native?.data?.free ?? 0n };
}

/** The XCM's transaction fee in PAS with its headroom, and the weighed weight the call declares.
 *  Estimated on the exact call, whose fee depends on its length and weight, not on the amounts. */
async function xcmTxFeeReserve(peopleApi: PeopleApi, keyAddress: string, args: WithdrawXcmArgs) {
  const maxWeight = await weighed(peopleApi, args);
  const estimate = await buildWithdrawXcm(peopleApi, { ...args, maxWeight }).getEstimatedFees(
    keyAddress,
    { customSignedExtensions: PEOPLE_TX_OPTIONS.customSignedExtensions } as never,
  );
  return { maxWeight, reserve: (estimate * BigInt(100 + XCM_TX_FEE_HEADROOM_PCT)) / 100n };
}

/** The sale with every figure at its longest: a stand-in for the fee estimate, whose charge
 *  grows with the call's length and not with the figures. */
function longestSale(route: ConversionRoute): Sale {
  if (route.tier === "dotusd") return { tier: "dotusd" };
  if (route.tier === "psm") {
    return {
      tier: "psm",
      external: route.external,
      feeRate: route.feeRate,
      redeemAmount: LONGEST_AMOUNT,
      externalOut: LONGEST_AMOUNT,
      holderHex: `0x${"00".repeat(32)}`,
      call: LONGEST_CALL,
    };
  }
  if (route.external === undefined) return { tier: "pool", minNativeOut: LONGEST_AMOUNT };
  return {
    tier: "pool",
    external: route.external,
    minNativeOut: LONGEST_AMOUNT,
    minOut: LONGEST_AMOUNT,
  };
}

export interface SizeSwapInput {
  peopleApi: PeopleApi;
  key: { address: string; publicKeyHex: string };
  /** The People pool's account, whose balances are the reserves. */
  poolAccount: string;
  /** The CASH the key holds; the swap may not take all of it. */
  cashBalance: bigint;
  destinationHex: string;
  claimerHex?: string;
  assetHubParaId: number;
  peopleParaId: number;
  /** The sale on Asset Hub, whose shape the XCM's fee depends on. */
  sale: ConversionRoute;
  /** How the CASH moves to Asset Hub; the XCM's length, and so its fee, depends on it. */
  transfer: CashTransfer;
}

/** The swap that buys the PAS the XCM needs on the key: the existential deposit, which must
 *  survive the fee charge, plus the fee reserve. With headroom on the CASH it may spend. */
export async function sizeSwap(input: SizeSwapInput): Promise<SwapArgs> {
  const [ed, reserves] = await Promise.all([
    input.peopleApi.constants.Balances.ExistentialDeposit(),
    readPoolReserves(input.peopleApi, input.poolAccount),
  ]);
  // A stand-in for the XCM. The fee grows with the call's length, and the amounts still unknown
  // encode to as many bytes as any real one will, so the reserve is not below the real fee.
  const { reserve } = await xcmTxFeeReserve(input.peopleApi, input.key.address, {
    cashToSend: input.cashBalance,
    pasToWithdraw: LONGEST_AMOUNT,
    payFeesPas: LONGEST_AMOUNT,
    remoteFeesCash: destinationEarmark(input.cashBalance, ASSET_HUB_FEE_BUFFER_CASH),
    sale: longestSale(input.sale),
    destinationHex: input.destinationHex,
    claimerHex: input.claimerHex ?? input.key.publicKeyHex,
    originHex: input.key.publicKeyHex,
    assetHubParaId: input.assetHubParaId,
    peopleParaId: input.peopleParaId,
    transfer: input.transfer,
  });
  const pasOut = ed + reserve;
  const quoted = cashInFor(pasOut, reserves);
  const headroomPct = swapHeadroomPct(reserves, pasOut);
  const cashInMax = (quoted * BigInt(Math.round((100 + headroomPct) * 100))) / 10_000n;
  if (cashInMax >= input.cashBalance) {
    throw new WithdrawUnderfundedError(input.cashBalance, pasOut);
  }
  return { keyAddress: input.key.address, pasOut, cashInMax };
}

export interface EstimateDirectFeesInput {
  peopleApi: PeopleApi;
  /** Any account on People; the fee estimates need one to be asked for. */
  address: string;
  /** The People pool's account, whose balances are the reserves. */
  poolAccount: string;
  assetHubParaId: number;
  peopleParaId: number;
  /** The sale on Asset Hub, whose shape the XCM's fee depends on. */
  sale: ConversionRoute;
  /** How the CASH moves to Asset Hub; the XCM's length, and so its fee, depends on it. */
  transfer: CashTransfer;
}

/** What a direct withdrawal costs in CASH before the sale, priced now for the summary: the swap
 *  that buys the fee PAS, the existential deposit plus the XCM's fee reserve at the pool's price,
 *  the swap's own fee at that price, and Asset Hub's fee buffer. On the safe side: the buffer is
 *  mostly refunded and the PAS left after People's fees ends up in the landing asset, which only
 *  a funded key's dry run can measure. */
export async function estimateDirectFeesCash(input: EstimateDirectFeesInput): Promise<bigint> {
  const { peopleApi, address } = input;
  const [ed, reserves] = await Promise.all([
    peopleApi.constants.Balances.ExistentialDeposit(),
    readPoolReserves(peopleApi, input.poolAccount),
  ]);
  const { reserve } = await xcmTxFeeReserve(peopleApi, address, {
    cashToSend: LONGEST_AMOUNT,
    pasToWithdraw: LONGEST_AMOUNT,
    payFeesPas: LONGEST_AMOUNT,
    remoteFeesCash: LONGEST_AMOUNT,
    sale: longestSale(input.sale),
    destinationHex: `0x${"00".repeat(32)}`,
    claimerHex: `0x${"00".repeat(32)}`,
    originHex: `0x${"00".repeat(32)}`,
    assetHubParaId: input.assetHubParaId,
    peopleParaId: input.peopleParaId,
    transfer: input.transfer,
  });
  const pasOut = ed + reserve;
  const swapFee = await buildSwap(peopleApi, {
    keyAddress: address,
    pasOut,
    cashInMax: LONGEST_AMOUNT,
  }).getEstimatedFees(address, PEOPLE_TX_OPTIONS as never);
  return cashInFor(pasOut, reserves) + cashInFor(swapFee, reserves) + ASSET_HUB_FEE_BUFFER_CASH;
}

/** One sizing of the XCM: the transaction to submit and what it will do. */
export interface XcmSizing {
  args: WithdrawXcmArgs;
  /** The XCM's transaction fee in PAS, with its headroom, left on the key for the charge. */
  txFeePasReserved: bigint;
  /** The message People forwards to Asset Hub for the final transaction. */
  forwarded: unknown;
  /** What the Asset Hub dry run credited to the destination, in the asset the sale lands. */
  landed: bigint;
  /** The seller's "receive at least", percent below the quote. Equals `safetyPct`. */
  promisePct: number;
  /** The exchange floor written into the program, percent below the quote. */
  safetyPct: number;
  /** The cap or the caller's ceiling left the bound short of what it is sized for. The sizing is
   *  still returned. False when the pool could not be read. */
  overCapacity: boolean;
}

export interface SizeXcmInput {
  peopleApi: PeopleApi;
  assetHubApi: AssetHubApi;
  /** The disposable key: its SS58 on People and its 32-byte public key. */
  key: { address: string; publicKeyHex: string };
  /** What the key holds after the swap; all the CASH and all the PAS leave. */
  cashOnKey: bigint;
  pasOnKey: bigint;
  /** The Asset Hub account that receives the funds, 32-byte public key hex. */
  destinationHex: string;
  /** The Asset Hub account that may claim a trapped program; defaults to the key. */
  claimerHex?: string;
  assetHubParaId: number;
  peopleParaId: number;
  /** The sale on Asset Hub, as the hand-off froze it. */
  sale: ConversionRoute;
  /** Ceiling on how far the sale may slip below its quote, percent. A pool sale of the native
   *  ships the bound the pool supports under it; the other sales, and a pool that cannot be
   *  read, ship it as is. */
  slippagePct: number;
  /** How the CASH moves to Asset Hub. */
  transfer: CashTransfer;
  /** The least the sale must land, for a withdrawal that promised a provider an exact figure.
   *  A floor below it is refused rather than raised: a tighter floor than the pool supports fails
   *  the program on Asset Hub and traps the funds there. */
  minLanding?: bigint;
}

/**
 * The sale cannot land what the withdrawal promised its provider: at today's price its floor is
 * below the payment, its fee and the key's existential deposit. Nothing has left People: the CASH
 * is still on the key there, beside the PAS its fee swap bought. Terminal for the sale: the worker
 * sends the key's funds home.
 */
export class CommitmentUnfundableError extends Error {
  constructor(
    readonly floor: bigint,
    readonly needed: bigint,
  ) {
    super(
      `withdraw sizing: the sale's floor of ${floor} PAS is below the ${needed} the promised payment needs`,
    );
    this.name = "CommitmentUnfundableError";
  }
}

/** What a dry run of the XCM on People reports. */
interface PeopleRun {
  ok: boolean;
  /** The failure named the way a rejected submit would be, when not ok. */
  reason?: string;
  trapped: bigint;
  forwarded: unknown | null;
}

async function dryRunOnPeople(
  peopleApi: PeopleApi,
  keyAddress: string,
  args: WithdrawXcmArgs,
  assetHubParaId: number,
): Promise<PeopleRun> {
  const dr = await peopleApi.apis.DryRunApi.dry_run_call(
    signedOrigin(keyAddress) as never,
    buildWithdrawXcm(peopleApi, args).decodedCall as never,
    5,
  );
  if (!dr.success) {
    return {
      ok: false,
      reason: `People would not dry-run the XCM (${dr.value.type})`,
      trapped: 0n,
      forwarded: null,
    };
  }
  const effects = dr.value;
  if (!effects.execution_result.success) {
    const reason = describeDispatchError(effects.execution_result.value.error, {
      message: withdrawMessage(args),
    });
    return { ok: false, reason: `People rejects the XCM: ${reason}`, trapped: 0n, forwarded: null };
  }
  return {
    ok: true,
    trapped: trappedIn(effects.emitted_events),
    forwarded: forwardedTo(effects, assetHubParaId),
  };
}

/** The native amount out of a VersionedAssets delivery-fee result. */
function nativeAmount(versioned: unknown): bigint {
  const assets = (versioned as { value?: Array<{ fun?: { type?: string; value?: bigint } }> })
    .value;
  const first = Array.isArray(assets) ? assets[0] : undefined;
  return first?.fun?.type === "Fungible" ? BigInt(first.fun.value ?? 0n) : 0n;
}

async function deliveryFee(
  peopleApi: PeopleApi,
  assetHubParaId: number,
  message: unknown,
): Promise<bigint> {
  const df = await peopleApi.apis.XcmPaymentApi.query_delivery_fees(
    siblingOrigin(assetHubParaId) as never,
    message as never,
    { type: "V5", value: PEOPLE_NATIVE } as never,
  );
  if (!df.success) throw new Error("withdraw sizing: People would not quote the delivery fee");
  return nativeAmount(df.value);
}

/** The weighed weight of the message, declared as the ceiling so the charge matches the use and
 *  nothing is refunded after the key is emptied. Null when the runtime will not weigh it. */
async function weighed(
  peopleApi: PeopleApi,
  args: WithdrawXcmArgs,
): Promise<{ ref_time: bigint; proof_size: bigint } | undefined> {
  const w = await peopleApi.apis.XcmPaymentApi.query_xcm_weight(withdrawMessage(args) as never);
  return w.success ? { ref_time: w.value.ref_time, proof_size: w.value.proof_size } : undefined;
}

/** The sale's exchange floor: the derived bound cut to the caller's ceiling, `overCapacity` judged
 *  after the cut. When the pool cannot be read, the ceiling ships with `overCapacity` false. */
export function saleBounds(input: {
  reserves: { in: bigint; out: bigint } | null;
  /** The sale's quote, PAS out for all the CASH on the key. */
  quoted: bigint;
  /** The CASH on the key, to convert the fee and the typical sale to PAS. */
  cashOnKey: bigint;
  /** The most the caller will ship, percent. */
  ceilingPct: number;
  feePpm?: bigint;
}): { safetyPct: number; promisePct: number; overCapacity: boolean } {
  if (input.reserves === null || input.cashOnKey <= 0n) {
    return { safetyPct: input.ceilingPct, promisePct: input.ceilingPct, overCapacity: false };
  }
  return withdrawalBounds({
    reserves: input.reserves,
    tradeOut: input.quoted,
    // Asset Hub's execution fee comes out of the sale before the bound is checked.
    feeTakenFromTrade: (input.quoted * ASSET_HUB_FEE_BUFFER_CASH) / input.cashOnKey,
    referenceTrade: (input.quoted * TYPICAL_WITHDRAWAL_CASH) / input.cashOnKey,
    ceilingPct: input.ceilingPct,
    ...(input.feePpm === undefined ? {} : { feePpm: input.feePpm }),
  });
}

/** Where the Asset Hub reads behind a sale are taken: at best, since finalized lags 12 to 60 s.
 *  Each read takes its own best block, so the dry run can see a block past the quote. */
export const SALE_READ_AT = { at: "best" } as const;

/** The Asset Hub pool's reserves as the sale trades them: CASH in, PAS out. Null when the runtime
 *  does not answer. */
export async function saleReserves(
  assetHubApi: AssetHubApi,
): Promise<{ in: bigint; out: bigint } | null> {
  try {
    const out = await (
      assetHubApi as unknown as {
        view: {
          AssetConversion: {
            get_reserves: (a: unknown, b: unknown, options?: unknown) => Promise<unknown>;
          };
        };
      }
    ).view.AssetConversion.get_reserves(PEOPLE_NATIVE, CASH_ON_ASSET_HUB, SALE_READ_AT);
    const pair = (out as { value?: unknown })?.value ?? out;
    if (!Array.isArray(pair) || pair.length < 2) return null;
    // Asked native-first, so swap the pair: the sale pays CASH for PAS.
    return { in: BigInt(pair[1] as never), out: BigInt(pair[0] as never) };
  } catch {
    return null;
  }
}

/** The bound a pool sale of `cashOnKey` CASH for the native is held to: the pool's own, read at the
 *  best head, cut to `ceilingPct`. */
async function poolSaleBounds(
  assetHubApi: AssetHubApi,
  cashOnKey: bigint,
  ceilingPct: number,
): Promise<{ safetyPct: number; promisePct: number; overCapacity: boolean }> {
  const native = await quoted(assetHubApi, CASH_ON_ASSET_HUB, PEOPLE_NATIVE, cashOnKey, "the sale");
  const reserves = await saleReserves(assetHubApi);
  return saleBounds({
    reserves,
    quoted: native,
    cashOnKey,
    ceilingPct,
    ...(reserves === null
      ? {}
      : {
          feePpm: await assetHubApi.constants.AssetConversion.LPFee().then(
            (ppm) => BigInt(ppm),
            () => DEFAULT_LP_FEE_PPM,
          ),
        }),
  });
}

/** What `amountIn` of one asset sells for in another on Asset Hub's pools, now, at the best head. */
async function quoted(
  assetHubApi: AssetHubApi,
  give: unknown,
  want: unknown,
  amountIn: bigint,
  what: string,
): Promise<bigint> {
  const out = await assetHubApi.apis.AssetConversionApi.quote_price_exact_tokens_for_tokens(
    give as never,
    want as never,
    amountIn,
    true,
    SALE_READ_AT,
  );
  if (out === undefined) throw new Error(`withdraw sizing: Asset Hub cannot quote ${what}`);
  return out;
}

const lessHeadroom = (amount: bigint, slippagePct: number): bigint =>
  (amount * BigInt(Math.round((100 - slippagePct) * 100))) / 10_000n;

export interface PriceSaleInput {
  assetHubApi: AssetHubApi;
  route: ConversionRoute;
  /** All the CASH the XCM teleports. */
  cashOnKey: bigint;
  /** The CASH earmarked for Asset Hub's fees out of it. */
  remoteFeesCash: bigint;
  slippagePct: number;
  /** The key's public key, whose account under People the PSM tier redeems as. */
  originHex: string;
  peopleParaId: number;
}

/** The sale and its figures, priced now. The pool tiers hold each hop to its quote less the
 *  headroom; all the CASH is sold there but Asset Hub's execution fee, a few thousand units the
 *  earmark's refund covers. One headroom for the whole sale: a stable's floor is the two hop
 *  quote less it, so the hops share it and the arrival floor is the same figure. The PSM tier
 *  redeems what travels less the earmark, at the fee rate the hand-off froze, as the key's own
 *  account on Asset Hub. The dotUSD tier has no price to hold. */
export async function priceSale(input: PriceSaleInput): Promise<Sale> {
  const { assetHubApi, route, slippagePct } = input;
  if (route.tier === "dotusd") return { tier: "dotusd" };
  if (route.tier === "psm") {
    const holder = await assetHubApi.apis.LocationToAccountApi.convert_location({
      type: "V5",
      value: originOnAssetHub(input.peopleParaId, input.originHex),
    } as never);
    if (!holder.success) {
      throw new Error("withdraw sizing: Asset Hub cannot name the key's account");
    }
    const redeemAmount = input.cashOnKey - input.remoteFeesCash;
    const call = await assetHubApi.tx.Psm.redeem({
      internal_asset: CASH_ON_ASSET_HUB as never,
      external_asset: STABLE_TOKENS[route.external].location as never,
      internal_amount: redeemAmount,
      max_fee: route.feeRate,
    }).getEncodedData();
    return {
      tier: "psm",
      external: route.external,
      feeRate: route.feeRate,
      redeemAmount,
      externalOut: psmRedeemOut(redeemAmount, route.feeRate),
      holderHex: toHex(AccountId().enc(holder.value as string)),
      call,
    };
  }
  const native = await quoted(
    assetHubApi,
    CASH_ON_ASSET_HUB,
    PEOPLE_NATIVE,
    input.cashOnKey,
    "the sale",
  );
  const minNativeOut = lessHeadroom(native, slippagePct);
  if (route.external === undefined) return { tier: "pool", minNativeOut };
  const stable = await quoted(
    assetHubApi,
    PEOPLE_NATIVE,
    STABLE_TOKENS[route.external].location,
    native,
    `the ${route.external} sale`,
  );
  return {
    tier: "pool",
    external: route.external,
    minNativeOut,
    minOut: lessHeadroom(stable, slippagePct),
  };
}

/** The least the sale lands in its asset, the floor the program holds it to; none on the dotUSD
 *  tier, which sells nothing it could hold to a price. */
function saleFloor(sale: Sale): bigint | undefined {
  if (sale.tier === "dotusd") return undefined;
  if (sale.tier === "psm") return sale.externalOut;
  return sale.external === undefined ? sale.minNativeOut : sale.minOut;
}

export async function sizeXcm(input: SizeXcmInput): Promise<XcmSizing> {
  const { peopleApi, assetHubApi, key } = input;
  const claimerHex = input.claimerHex ?? key.publicKeyHex;
  const remoteFeesCash = destinationEarmark(input.cashOnKey, ASSET_HUB_FEE_BUFFER_CASH);

  // A pool sale of the native is held to the bound the pool supports for it, cut to the ceiling. A
  // stable's two hops, the PSM and the dotUSD tier keep the ceiling as it is: the bound is measured
  // on the CASH and native pool only.
  const { safetyPct, promisePct, overCapacity } =
    input.sale.tier === "pool" && input.sale.external === undefined
      ? await poolSaleBounds(assetHubApi, input.cashOnKey, input.slippagePct)
      : { safetyPct: input.slippagePct, promisePct: input.slippagePct, overCapacity: false };
  const sale = await priceSale({
    assetHubApi,
    route: input.sale,
    cashOnKey: input.cashOnKey,
    remoteFeesCash,
    slippagePct: safetyPct,
    originHex: key.publicKeyHex,
    peopleParaId: input.peopleParaId,
  });
  // A withdrawal that promised a provider an exact figure needs the sale's floor to cover it.
  const floor = saleFloor(sale);
  if (input.minLanding !== undefined && floor !== undefined && floor < input.minLanding) {
    throw new CommitmentUnfundableError(floor, input.minLanding);
  }

  const base = (pasToWithdraw: bigint, payFeesPas: bigint): WithdrawXcmArgs => ({
    cashToSend: input.cashOnKey,
    pasToWithdraw,
    payFeesPas,
    remoteFeesCash,
    sale,
    destinationHex: input.destinationHex,
    claimerHex,
    originHex: key.publicKeyHex,
    assetHubParaId: input.assetHubParaId,
    peopleParaId: input.peopleParaId,
    transfer: input.transfer,
  });

  // The transaction fee in PAS, for the exact call, with headroom. Left on the key for the
  // charge, which must also leave the existential deposit in place.
  const { maxWeight, reserve: txFeePasReserved } = await xcmTxFeeReserve(
    peopleApi,
    key.address,
    base(input.pasOnKey, input.pasOnKey),
  );
  const ed = await peopleApi.constants.Balances.ExistentialDeposit();
  if (input.pasOnKey < ed + txFeePasReserved) {
    throw new NeedsSwapError(input.pasOnKey, ed + txFeePasReserved);
  }
  const pasToWithdraw = input.pasOnKey - txFeePasReserved;
  const withWeight = (pasToWithdrawNow: bigint, payFeesPas: bigint): WithdrawXcmArgs => ({
    ...base(pasToWithdrawNow, payFeesPas),
    maxWeight,
  });

  // Measure People's charge: pay with every PAS withdrawn, read back what is left as trapped.
  const generous = withWeight(pasToWithdraw, pasToWithdraw);
  const first = await dryRunOnPeople(peopleApi, key.address, generous, input.assetHubParaId);
  if (!first.ok) {
    // People's fees exceed every PAS withdrawn: another swap's worth is the best estimate.
    if (first.reason?.includes("NotHoldingFees") || first.reason?.includes("TooExpensive")) {
      throw new NeedsSwapError(input.pasOnKey, input.pasOnKey + ed);
    }
    throw new Error(`withdraw sizing: ${first.reason}`);
  }
  if (first.forwarded === null) {
    throw new Error("withdraw sizing: People forwards nothing to Asset Hub");
  }
  const charged = pasToWithdraw - first.trapped;
  const local = charged - (await deliveryFee(peopleApi, input.assetHubParaId, first.forwarded));

  // The final message also carries the PAS the allowance leaves, so its delivery costs more.
  // Quote that on a stand-in, then confirm the allowance leaves nothing trapped.
  let payFeesPas =
    local +
    (await deliveryFee(
      peopleApi,
      input.assetHubParaId,
      forwardedStandIn(withWeight(pasToWithdraw, charged)),
    ));
  let final = generous;
  let run: PeopleRun | null = null;
  for (let round = 0; round < FEE_ROUNDS; round += 1) {
    if (payFeesPas >= pasToWithdraw)
      throw new NeedsSwapError(input.pasOnKey, payFeesPas + txFeePasReserved);
    final = withWeight(pasToWithdraw, payFeesPas);
    run = await dryRunOnPeople(peopleApi, key.address, final, input.assetHubParaId);
    if (run.ok && run.trapped === 0n) break;
    if (run.ok) {
      payFeesPas -= run.trapped;
    } else if (run.reason?.includes("NotHoldingFees")) {
      payFeesPas += payFeesPas / 100n + 1n;
    } else {
      throw new Error(`withdraw sizing: ${run.reason}`);
    }
    run = null;
  }
  if (run === null || run.forwarded === null) {
    throw new Error("withdraw sizing: no exact People fee allowance found");
  }

  const landed = await dryRunOnAssetHub(
    assetHubApi,
    input.peopleParaId,
    run.forwarded,
    input.destinationHex,
    input.sale,
  );
  return {
    args: final,
    txFeePasReserved,
    forwarded: run.forwarded,
    landed,
    promisePct,
    safetyPct,
    overCapacity,
  };
}

/** Runs the forwarded program on Asset Hub as People. Throws when it fails, traps, or credits
 *  the destination nothing. Returns what it credits in the asset the sale lands: the native's
 *  deposit for the pool, the token's for a stable and for dotUSD. */
export async function dryRunOnAssetHub(
  assetHubApi: AssetHubApi,
  peopleParaId: number,
  forwarded: unknown,
  destinationHex: string,
  sale: ConversionRoute,
): Promise<bigint> {
  // At best, like the quote, so the landing is priced near the program's floor.
  const dr = await assetHubApi.apis.DryRunApi.dry_run_xcm(
    siblingOrigin(peopleParaId) as never,
    forwarded as never,
    SALE_READ_AT,
  );
  if (!dr.success) throw new Error("not submitted: Asset Hub would not dry-run the program");
  const outcome = dr.value.execution_result;
  if (outcome.type !== "Complete") {
    // The PSM tier checks the redeem went through right after it; a false expectation there is
    // the PSM refusing, which the dry run cannot name further.
    const error = xcmErrorName(outcome);
    const reason =
      sale.tier === "psm" && error === "ExpectationFalse"
        ? "the PSM refused the redeem"
        : `the program fails on Asset Hub with ${error}`;
    throw new Error(`not submitted: ${reason}`);
  }
  const trapped = trappedIn(dr.value.emitted_events);
  if (trapped > 0n)
    throw new Error(`not submitted: the program would trap ${trapped} on Asset Hub`);
  const { assetHubId } = depositTokenOf(sale);
  const landed =
    assetHubId === undefined
      ? creditedTo(dr.value.emitted_events, destinationHex, "native")
      : creditedTo(dr.value.emitted_events, destinationHex, "asset", assetHubId);
  if (landed === 0n) {
    throw new Error("not submitted: nothing would reach the destination on Asset Hub");
  }
  return landed;
}
