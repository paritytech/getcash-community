// The PSM tier's second leg, signed by the key on Asset Hub once the XCM has landed the CASH on
// its own account there: the redeem through the PSM, with the stable sent on to the destination
// in the same batch, or the pool swap along CASH, PAS and the stable when the user chose the
// pool from a hold. One local transaction either way, so a refusal reverts whole and the dry run
// names the PSM's own error, where a redeem inside the XCM could only fail an expectation after
// the deposit stood.
//
// The key holds only CASH, so the dispatch fee is charged in CASH through its pool and priced the
// way the on-ramp prices a fee in a stable. The redeem burns from the key's CASH account, which
// pallet-assets reaps below the asset's min_balance; the sizing leaves that minimum and the
// fee's margin behind so the account, and with it the key's nonce, survive the burn.

import { AccountId } from "polkadot-api";
import { TOKENS } from "@getsome/core";
import {
  asLocation,
  describeDispatchError,
  priceNativeFeeIn,
  ProgramRejectedError,
  signedOrigin,
  STABLE_TOKENS,
  stableLocation,
  withFeeMargin,
  type PsmRoute,
} from "@getsome/funding";
import { type AssetHubApi, quoted } from "./fees";
import { ASSET_HUB_CASH_TX_OPTIONS } from "./paseo";
import { psmRedeemOut } from "./program";
import { buildSweep } from "./sweep";

const CASH = asLocation(TOKENS.CASH.location);
const NATIVE = asLocation(TOKENS.PAS.location);
const accountId = AccountId();

/** The chain's floors a redeem is held to, read live before each sizing. */
export interface RedeemFloors {
  /** Below this the key's CASH account is reaped; the sizing leaves it behind. */
  cashMinBalance: bigint;
  /** The least the stable's receiving account can hold. */
  externalMinBalance: bigint;
  /** The least the PSM redeems. */
  minSwapAmount: bigint;
}

export async function readRedeemFloors(api: AssetHubApi, route: PsmRoute): Promise<RedeemFloors> {
  const external = STABLE_TOKENS[route.external];
  const [cash, stable, instance] = await Promise.all([
    api.query.Assets.Asset.getValue(TOKENS.CASH.assetHubId),
    api.query.Assets.Asset.getValue(external.assetHubId),
    api.query.Psm.Psm.getValue(CASH),
  ]);
  if (cash === undefined) throw new Error("CASH is not an asset on Asset Hub");
  if (stable === undefined) throw new Error(`${external.symbol} is not an asset on Asset Hub`);
  if (instance === undefined) throw new Error("the PSM has no instance for CASH");
  return {
    cashMinBalance: cash.min_balance,
    externalMinBalance: stable.min_balance,
    minSwapAmount: instance.min_swap_amount,
  };
}

/** What the key holds cannot fund an exit the chain would take: once the fee and the account's
 *  minimum are left behind, what is left is under the PSM's minimum swap or under what the
 *  stable's receiving account can hold. */
export class RedeemTooSmallError extends Error {
  constructor(
    readonly cashOnKey: bigint,
    readonly floor: bigint,
  ) {
    super(`redeem sizing: ${cashOnKey} CASH on the key cannot fund an exit of at least ${floor}`);
    this.name = "RedeemTooSmallError";
  }
}

/** The CASH an exit takes from the key: everything but the dispatch fee with its margin and the
 *  CASH account's minimum. */
export function cashToExit(cashOnKey: bigint, feeCash: bigint, floors: RedeemFloors): bigint {
  const cashIn = cashOnKey - withFeeMargin(feeCash) - floors.cashMinBalance;
  if (cashIn <= 0n) throw new RedeemTooSmallError(cashOnKey, floors.minSwapAmount);
  return cashIn;
}

/** The redeem sized from what the key holds: `cashIn` through the PSM for `net` of the stable
 *  at the fee rate the hand-off froze. Throws when the net is under a floor the chain would
 *  refuse it at. */
export function sizeRedeem(
  cashOnKey: bigint,
  feeCash: bigint,
  route: PsmRoute,
  floors: RedeemFloors,
): { cashIn: bigint; net: bigint } {
  const cashIn = cashToExit(cashOnKey, feeCash, floors);
  const net = psmRedeemOut(cashIn, route.feeRate);
  const floor =
    floors.minSwapAmount > floors.externalMinBalance
      ? floors.minSwapAmount
      : floors.externalMinBalance;
  if (net < floor) throw new RedeemTooSmallError(cashOnKey, floor);
  return { cashIn, net };
}

export interface RedeemBatchArgs {
  route: PsmRoute;
  /** The CASH the redeem burns. */
  cashIn: bigint;
  /** The account the stable is sent on to, SS58; absent, it stays on the key. */
  deliverTo?: string;
}

/** `Psm.redeem` of `cashIn` for the stable at the frozen rate, wrapped in a `Utility.batch_all`
 *  with `Assets.transfer_all` of the stable to `deliverTo` when one is named. */
export function buildRedeemBatch(api: AssetHubApi, args: RedeemBatchArgs) {
  const redeem = api.tx.Psm.redeem({
    internal_asset: CASH,
    external_asset: stableLocation(args.route.external),
    internal_amount: args.cashIn,
    max_fee: args.route.feeRate,
  });
  if (args.deliverTo === undefined) return redeem;
  const transfer = buildSweep(api, args.deliverTo, STABLE_TOKENS[args.route.external]);
  return api.tx.Utility.batch_all({ calls: [redeem.decodedCall, transfer.decodedCall] });
}

export interface PoolExitArgs {
  route: PsmRoute;
  /** The CASH the swap sells. */
  cashIn: bigint;
  /** The least stable the swap must pay out, or it fails. */
  minOut: bigint;
  /** The account the stable is paid to, SS58. */
  deliverTo: string;
}

/** The swap along CASH, PAS and the stable on Asset Hub's pools, paid to `deliverTo`. */
export function buildPoolExit(api: AssetHubApi, args: PoolExitArgs) {
  return api.tx.AssetConversion.swap_exact_tokens_for_tokens({
    path: [CASH, NATIVE, stableLocation(args.route.external)],
    amount_in: args.cashIn,
    amount_out_min: args.minOut,
    send_to: args.deliverTo,
    keep_alive: false,
  });
}

/** What `cashIn` sells for in the stable along the two hops, now. */
export async function quotePoolExit(
  api: AssetHubApi,
  route: PsmRoute,
  cashIn: bigint,
): Promise<bigint> {
  const native = await quoted(api, CASH, NATIVE, cashIn, "the pool exit");
  return quoted(api, NATIVE, stableLocation(route.external), native, `the ${route.external} exit`);
}

export type ExitCall = ReturnType<typeof buildRedeemBatch> | ReturnType<typeof buildPoolExit>;

/** The exit's dispatch fee in CASH: the estimate in the native, priced through the CASH pool as
 *  ChargeAssetTxPayment will charge it. */
export async function estimateRedeemFeeCash(
  api: AssetHubApi,
  call: ExitCall,
  keyAddress: string,
): Promise<bigint> {
  const feeNative = await call.getEstimatedFees(keyAddress, ASSET_HUB_CASH_TX_OPTIONS);
  return priceNativeFeeIn(api, CASH, feeNative, TOKENS.CASH.symbol);
}

/** Runs the exit as the key without submitting it. Throws ProgramRejectedError, carrying the
 *  dispatch error, when Asset Hub would fail it. */
export async function dryRunRedeem(
  api: AssetHubApi,
  call: ExitCall,
  keyAddress: string,
): Promise<void> {
  const dr = await api.apis.DryRunApi.dry_run_call(
    signedOrigin(keyAddress) as never,
    call.decodedCall as never,
    5,
  );
  if (!dr.success) throw new Error("not submitted: Asset Hub would not dry-run the exit");
  if (!dr.value.execution_result.success) {
    const { error } = dr.value.execution_result.value;
    throw new ProgramRejectedError(error, describeDispatchError(error));
  }
}

/** The SS58 of a public key hex, as the calls name an account. */
export const addressOf = (hex: string): string => accountId.dec(hex);
