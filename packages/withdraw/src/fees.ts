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
// runs the forwarded program and the PAS credited to the destination is read back.
//
// THE SALE'S FLOOR MEANS TWO DIFFERENT THINGS. For a self-custody withdrawal it is a slippage
// guard: the proceeds are the user's own, so a price that floats is only a worse price. For an
// off-ramp it is a solvency guard, because a provider was promised an exact figure and the
// payment that follows the sale must actually be affordable out of what the sale returns. The
// floor is then the commitment plus that payment's transfer fee plus Asset Hub's existential
// deposit, and the slippage guard on top of it when it is higher. The fee is estimated on the
// real transfer call rather than constanted, so a fee schedule change cannot quietly under-fund
// the floor. A sale that cannot clear the floor fails the program on Asset Hub, which means the
// XCM fails its dry run on People and is never signed — nothing is spent and nothing is stranded.
//
// The XCM's transaction fee is paid in PAS and estimated with a margin. People withdraws a fee
// while keeping the account alive, so the key must hold the existential deposit on top of the
// fee when the XCM is signed; the swap buys both. A dry run charges no fee, so the withdrawn PAS
// is what the key holds less the reserve; what the reserve leaves unspent is below the
// existential deposit and the chain reaps it with the account.

import { paseo_next_v2 } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";
import { CASH_LOCATION } from "@getsome/people";
import {
  creditedTo,
  describeDispatchError,
  destinationEarmark,
  forwardedTo,
  siblingOrigin,
  signedOrigin,
  trappedIn,
} from "@getsome/funding";
import { assetHubAddressFor } from "./destination";
import { PEOPLE_NATIVE, PEOPLE_TX_OPTIONS } from "./paseo";
import { cashInFor, type PoolReserves } from "./pool";
import {
  buildProviderPayment,
  buildWithdrawXcm,
  CASH_ON_ASSET_HUB,
  forwardedStandIn,
  withdrawMessage,
  type PeopleApi,
  type SwapArgs,
  type WithdrawXcmArgs,
} from "./program";

export type AssetHubApi = TypedApi<typeof paseo_next_v2>;

/** CASH set aside for Asset Hub's execution fee, above the one percent floor. The measured fee is
 *  a few thousand units; the unused part is refunded into the sale. */
export const ASSET_HUB_FEE_BUFFER_CASH = 10_000n;

/** Headroom the swap may spend above the quoted CASH, percent. What it does not spend leaves
 *  with the XCM. */
export const SWAP_HEADROOM_PCT = 2;

/** Headroom on the XCM's transaction fee estimate, percent. The unspent part is reaped dust. */
export const XCM_TX_FEE_HEADROOM_PCT = 5;

/** Headroom on the Asset Hub payment's fee, percent. The fee is estimated twice, once to put
 *  the floor under the sale and again at the moment of paying, and an estimate that rose in
 *  between would leave the sale a hair under what the payment needs — the money on the burner
 *  and the provider never paid. Generous, because the fee is a rounding error beside the
 *  payment: a quarter of a transfer fee is a ten-thousandth of a typical commitment. */
export const ASSET_HUB_TRANSFER_FEE_HEADROOM_PCT = 25;

/** Rounds of measure and confirm before the sizing gives up on an exact People allowance. */
const FEE_ROUNDS = 3;

/** An amount whose compact encoding is the longest any amount below 2^64 gets: nine bytes. */
const LONGEST_AMOUNT = 2n ** 63n;

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

/** The commitment can no longer be funded: the sale's floor has to be at least the exact payment
 *  plus its fee and the deposit, and the pool has moved so far that no sale of this CASH can
 *  reach it. Distinct from NeedsSwapError and from a transient failure on purpose — the answer is
 *  to cancel the provider's order, not to retry, because retrying cannot make the pool come back
 *  in time. */
export class CommitmentUnfundableError extends Error {
  constructor(
    readonly quoted: bigint,
    readonly floor: bigint,
  ) {
    super(
      `withdraw sizing: the sale quotes ${quoted} and the committed payment needs ${floor}; the pool moved`,
    );
    this.name = "CommitmentUnfundableError";
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
    cashToTeleport: input.cashBalance,
    pasToWithdraw: LONGEST_AMOUNT,
    payFeesPas: LONGEST_AMOUNT,
    remoteFeesCash: destinationEarmark(input.cashBalance, ASSET_HUB_FEE_BUFFER_CASH),
    minPasOut: LONGEST_AMOUNT,
    destinationHex: input.destinationHex,
    claimerHex: input.claimerHex ?? input.key.publicKeyHex,
    assetHubParaId: input.assetHubParaId,
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

/** One sizing of the XCM: the transaction to submit and what it will do. */
export interface XcmSizing {
  args: WithdrawXcmArgs;
  /** The XCM's transaction fee in PAS, with its headroom, left on the key for the charge. */
  txFeePasReserved: bigint;
  /** The message People forwards to Asset Hub for the final transaction. */
  forwarded: unknown;
  /** PAS the Asset Hub dry run credited to the destination. */
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
  /** The Asset Hub account that receives the PAS, 32-byte public key hex. */
  destinationHex: string;
  /** The Asset Hub account that may claim a trapped program; defaults to the key. */
  claimerHex?: string;
  assetHubParaId: number;
  peopleParaId: number;
  /** How far below the quoted sale the Asset Hub price may move before the program fails there. */
  slippagePct: number;
  /** The exact amount committed to a fiat provider, planck. Absent for a self-custody
   *  withdrawal, whose sale may float freely. Present, it replaces the slippage floor with a
   *  solvency floor: see `saleFloor`. */
  commitPlanck?: bigint;
  /** The provider's Asset Hub deposit address; required with `commitPlanck`, since the transfer
   *  fee is estimated on the real payment call rather than guessed. */
  payoutAddress?: string;
}

/**
 * The least PAS the sale on Asset Hub may return.
 *
 * Without a commitment this is the quote less the slippage the caller allows: the proceeds are
 * the user's own and a floating output is fine.
 *
 * With one it must also be enough to make the payment, or the whole point of splitting the
 * payment out of the XCM is lost — the burner would be left holding proceeds it cannot pay the
 * provider from. So the floor is the payment, its transfer fee, and the existential deposit that
 * has to stay behind for the later residue return, and the slippage floor still applies when it
 * is the higher of the two. An XCM that cannot clear it fails its dry run on People and is never
 * signed.
 */
export function saleFloor(input: {
  quoted: bigint;
  slippagePct: number;
  commitPlanck?: bigint;
  transferFeePlanck?: bigint;
  existentialDeposit?: bigint;
}): bigint {
  const slippage = (input.quoted * BigInt(Math.round((100 - input.slippagePct) * 100))) / 10_000n;
  if (input.commitPlanck === undefined) return slippage;
  const solvency =
    input.commitPlanck + (input.transferFeePlanck ?? 0n) + (input.existentialDeposit ?? 0n);
  return solvency > slippage ? solvency : slippage;
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

/** What the exact payment costs the burner on top of the payment itself: the transfer's fee,
 *  estimated on the real call so a fee schedule change cannot silently under-fund it and carried
 *  with headroom so the two estimates cannot disagree in the direction that stalls the payout,
 *  and Asset Hub's existential deposit, read from the chain's constants as `sizeSwap` reads
 *  People's. Both the sale's floor and the gate that lets the payment go use this one answer. */
export async function assetHubPaymentOverhead(
  assetHubApi: AssetHubApi,
  burnerPublicKeyHex: string,
  args: { commitPlanck?: bigint; payoutAddress?: string },
): Promise<{ transferFeePlanck: bigint; existentialDeposit: bigint }> {
  if (args.payoutAddress === undefined) {
    throw new Error("withdraw sizing: a committed withdrawal needs the provider's payout address");
  }
  const payment = buildProviderPayment(assetHubApi, {
    payoutAddress: args.payoutAddress,
    amount: args.commitPlanck ?? 0n,
  });
  const [estimate, existentialDeposit] = await Promise.all([
    payment.getEstimatedFees(assetHubAddressFor(burnerPublicKeyHex)),
    assetHubApi.constants.Balances.ExistentialDeposit(),
  ]);
  return {
    transferFeePlanck: (estimate * BigInt(100 + ASSET_HUB_TRANSFER_FEE_HEADROOM_PCT)) / 100n,
    existentialDeposit,
  };
}

export async function sizeXcm(input: SizeXcmInput): Promise<XcmSizing> {
  const { peopleApi, assetHubApi, key } = input;
  const claimerHex = input.claimerHex ?? key.publicKeyHex;
  const remoteFeesCash = destinationEarmark(input.cashOnKey, ASSET_HUB_FEE_BUFFER_CASH);

  // The price floor on Asset Hub: the sale quoted now, less the headroom. All the CASH is sold
  // there but Asset Hub's execution fee, a few thousand units the earmark's refund covers.
  const quoted = await assetHubApi.apis.AssetConversionApi.quote_price_exact_tokens_for_tokens(
    CASH_ON_ASSET_HUB as never,
    PEOPLE_NATIVE as never,
    input.cashOnKey,
    true,
  );
  if (quoted === undefined) throw new Error("withdraw sizing: Asset Hub cannot quote the sale");
  const minPasOut = saleFloor({
    quoted,
    slippagePct: input.slippagePct,
    commitPlanck: input.commitPlanck,
    ...(input.commitPlanck === undefined
      ? {}
      : await assetHubPaymentOverhead(assetHubApi, key.publicKeyHex, input)),
  });
  // The sale cannot reach the floor at any price the pool will give: the commitment is dead and
  // the order it belongs to has to be cancelled, so say so distinctly rather than dry-running a
  // program that is certain to fail.
  if (input.commitPlanck !== undefined && minPasOut > quoted) {
    throw new CommitmentUnfundableError(quoted, minPasOut);
  }

  const base = (pasToWithdraw: bigint, payFeesPas: bigint): WithdrawXcmArgs => ({
    cashToTeleport: input.cashOnKey,
    pasToWithdraw,
    payFeesPas,
    remoteFeesCash,
    minPasOut,
    destinationHex: input.destinationHex,
    claimerHex,
    assetHubParaId: input.assetHubParaId,
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
  );
  return { args: final, txFeePasReserved, forwarded: run.forwarded, landed };
}

/** Runs the forwarded program on Asset Hub as People. Throws when it fails, traps, or credits
 *  the destination nothing. Returns the PAS credited. */
export async function dryRunOnAssetHub(
  assetHubApi: AssetHubApi,
  peopleParaId: number,
  forwarded: unknown,
  destinationHex: string,
): Promise<bigint> {
  const dr = await assetHubApi.apis.DryRunApi.dry_run_xcm(
    siblingOrigin(peopleParaId) as never,
    forwarded as never,
  );
  if (!dr.success) throw new Error("not submitted: Asset Hub would not dry-run the program");
  const outcome = dr.value.execution_result;
  if (outcome.type !== "Complete") {
    const error = (outcome.value as { error?: { type?: string } }).error?.type ?? outcome.type;
    throw new Error(`not submitted: the program fails on Asset Hub with ${error}`);
  }
  const trapped = trappedIn(dr.value.emitted_events);
  if (trapped > 0n)
    throw new Error(`not submitted: the program would trap ${trapped} on Asset Hub`);
  const landed = creditedTo(dr.value.emitted_events, destinationHex, "native");
  if (landed === 0n) {
    throw new Error("not submitted: nothing would reach the destination on Asset Hub");
  }
  return landed;
}
