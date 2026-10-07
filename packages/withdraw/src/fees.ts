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
import type { TypedApi } from "polkadot-api";
import { TOKENS } from "@getsome/core";
import { CASH_LOCATION } from "@getsome/people";
import {
  creditedTo,
  depositTokenOf,
  describeDispatchError,
  destinationEarmark,
  forwardedTo,
  siblingOrigin,
  signedOrigin,
  STABLE_TOKENS,
  trappedIn,
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
  withdrawMessage,
  type PeopleApi,
  type Sale,
  type SwapArgs,
  type WithdrawXcmArgs,
} from "./program";

export type AssetHubApi = TypedApi<typeof paseo_next_v2>;

/** CASH set aside for Asset Hub's execution fee, above the one percent floor. The programs
 *  measure a few thousand units, priced through the pool, so this leaves room for the price to
 *  move; the unused part is refunded into the sale. */
export const ASSET_HUB_FEE_BUFFER_CASH = 30_000n;

/** Headroom the swap may spend above the quoted CASH, percent. What it does not spend leaves
 *  with the XCM. */
export const SWAP_HEADROOM_PCT = 2;

/** Headroom on the XCM's transaction fee estimate, percent. The unspent part is reaped dust. */
export const XCM_TX_FEE_HEADROOM_PCT = 5;

/** Rounds of measure and confirm before the sizing gives up on an exact People allowance. */
const FEE_ROUNDS = 3;

/** An amount whose compact encoding is the longest any amount below 2^64 gets: nine bytes. */
const LONGEST_AMOUNT = 2n ** 63n;

/** The CASH a PSM-tier withdrawal has to redeem out of what the key holds on People: all of it
 *  but the earmark for Asset Hub's fees. The figure a sale is quoted on; the redeem itself is
 *  sized from what reaches the key on Asset Hub. */
export const redeemAmountOf = (cashOnKey: bigint): bigint =>
  cashOnKey - destinationEarmark(cashOnKey, ASSET_HUB_FEE_BUFFER_CASH);

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
  if (route.tier === "dotusd" || route.tier === "psm") return route;
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
    assetHubParaId: input.assetHubParaId,
    peopleParaId: input.peopleParaId,
    transfer: input.transfer,
  });
  const pasOut = ed + reserve;
  const quoted = cashInFor(pasOut, reserves);
  const cashInMax = (quoted * BigInt(100 + SWAP_HEADROOM_PCT)) / 100n;
  if (cashInMax >= input.cashBalance) {
    throw new Error(
      `withdraw sizing: ${input.cashBalance} CASH cannot buy the ${pasOut} PAS the fees need`,
    );
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
  /** What the Asset Hub dry run credited to the destination, in the asset the sale lands; to
   *  the key, in CASH, on the PSM tier. */
  landed: bigint;
}

export interface SizeXcmInput {
  peopleApi: PeopleApi;
  assetHubApi: AssetHubApi;
  /** The disposable key: its SS58 on People and its 32-byte public key. */
  key: { address: string; publicKeyHex: string };
  /** What the key holds after the swap; all the CASH and all the PAS leave. */
  cashOnKey: bigint;
  pasOnKey: bigint;
  /** The Asset Hub account that receives the funds, 32-byte public key hex. The PSM tier's XCM
   *  lands on the key instead, and the redeem pays here. */
  destinationHex: string;
  /** The Asset Hub account that may claim a trapped program; defaults to the key. */
  claimerHex?: string;
  assetHubParaId: number;
  peopleParaId: number;
  /** The sale on Asset Hub, as the hand-off froze it. */
  sale: ConversionRoute;
  /** How far below the quoted sale the Asset Hub price may move before the program fails there. */
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

/** What `amountIn` of one asset sells for in another on Asset Hub's pools, now. */
export async function quoted(
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
  );
  if (out === undefined) throw new Error(`withdraw sizing: Asset Hub cannot quote ${what}`);
  return out;
}

/** `amount` less `slippagePct` of it: the floor a quote is held to. */
export const lessHeadroom = (amount: bigint, slippagePct: number): bigint =>
  (amount * BigInt(Math.round((100 - slippagePct) * 100))) / 10_000n;

export interface PriceSaleInput {
  assetHubApi: AssetHubApi;
  route: ConversionRoute;
  /** All the CASH the XCM teleports. */
  cashOnKey: bigint;
  slippagePct: number;
}

/** The sale and its figures, priced now. The pool tiers hold each hop to its quote less the
 *  headroom; all the CASH is sold there but Asset Hub's execution fee, a few thousand units the
 *  earmark's refund covers. One headroom for the whole sale: a stable's floor is the two hop
 *  quote less it, so the hops share it and the arrival floor is the same figure. The PSM and
 *  dotUSD tiers have no price to hold: neither sells the CASH in the XCM. */
export async function priceSale(input: PriceSaleInput): Promise<Sale> {
  const { assetHubApi, route, slippagePct } = input;
  if (route.tier === "dotusd" || route.tier === "psm") return route;
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
 *  and PSM tiers, which sell nothing in the XCM they could hold to a price. The PSM tier's
 *  promise is held at the redeem instead. */
function saleFloor(sale: Sale): bigint | undefined {
  if (sale.tier === "dotusd" || sale.tier === "psm") return undefined;
  return sale.external === undefined ? sale.minNativeOut : sale.minOut;
}

/** The asset the forwarded program deposits: the CASH itself on the PSM tier, which lands on the
 *  key and redeems from there; the sale's token otherwise. */
const landingAssetOf = (sale: ConversionRoute) =>
  sale.tier === "psm" ? TOKENS.CASH : depositTokenOf(sale);

export async function sizeXcm(input: SizeXcmInput): Promise<XcmSizing> {
  const { peopleApi, assetHubApi, key } = input;
  const claimerHex = input.claimerHex ?? key.publicKeyHex;
  // The PSM tier lands on the key itself; the hand-off's destination is where the redeem pays.
  const landingHex = input.sale.tier === "psm" ? key.publicKeyHex : input.destinationHex;
  const remoteFeesCash = destinationEarmark(input.cashOnKey, ASSET_HUB_FEE_BUFFER_CASH);
  const sale = await priceSale({
    assetHubApi,
    route: input.sale,
    cashOnKey: input.cashOnKey,
    slippagePct: input.slippagePct,
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
    destinationHex: landingHex,
    claimerHex,
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
    landingHex,
    input.sale,
  );
  return { args: final, txFeePasReserved, forwarded: run.forwarded, landed };
}

/** Runs the forwarded program on Asset Hub as People. Throws when it fails, traps, or credits
 *  `landingHex` nothing. Returns what it credits there in the asset the program lands: the
 *  native's deposit for the pool, the token's for a stable and for dotUSD, the CASH's for the PSM
 *  tier, whose landing is the key. */
export async function dryRunOnAssetHub(
  assetHubApi: AssetHubApi,
  peopleParaId: number,
  forwarded: unknown,
  landingHex: string,
  sale: ConversionRoute,
): Promise<bigint> {
  const dr = await assetHubApi.apis.DryRunApi.dry_run_xcm(
    siblingOrigin(peopleParaId) as never,
    forwarded as never,
  );
  if (!dr.success) throw new Error("not submitted: Asset Hub would not dry-run the program");
  const outcome = dr.value.execution_result;
  if (outcome.type !== "Complete") {
    throw new Error(`not submitted: the program fails on Asset Hub with ${xcmErrorName(outcome)}`);
  }
  const trapped = trappedIn(dr.value.emitted_events);
  if (trapped > 0n)
    throw new Error(`not submitted: the program would trap ${trapped} on Asset Hub`);
  const { assetHubId } = landingAssetOf(sale);
  const landed =
    assetHubId === undefined
      ? creditedTo(dr.value.emitted_events, landingHex, "native")
      : creditedTo(dr.value.emitted_events, landingHex, "asset", assetHubId);
  if (landed === 0n) {
    throw new Error("not submitted: nothing would reach the destination on Asset Hub");
  }
  return landed;
}
