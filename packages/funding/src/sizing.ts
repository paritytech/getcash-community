// The live reads every tier's sizing starts from, and the reverse sizing: what a deposit already
// on the burner converts to on a route.

import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import type { PolkadotClient } from "polkadot-api";
import { chooseCashTransfer } from "./cash-transfer";
import {
  DepositBelowFeesError,
  destinationEarmark,
  estimateDestinationFeeCash,
  estimateDotUsdProgramFees,
  estimateFundingProgramFees,
  estimateStableProgramFees,
  withFeeMargin,
  type Pool,
  type StableLegFees,
} from "./funding-program";
import { PASEO_ASSET_HUB_PARA_ID } from "./paseo";
import { discoverPools, quoteNativeOut, quoteUnderlyingOut } from "./pipeline";
import { estimatePsmBatchFees, psmMintOut } from "./psm-batch";
import type { ConversionRoute } from "./route";
import { STABLE_TOKENS } from "./stable";

/** A throwaway 32-byte beneficiary for the fee reads; it does not affect any fee. */
export const ZERO_32 = `0x${"00".repeat(32)}`;

export interface SizingArgs {
  ahClient: PolkadotClient;
  peopleClient: PolkadotClient;
  underlyingAssetId: number;
  peopleParaId: number;
  settleAmount: bigint;
  /** Any valid address; getEstimatedFees does not depend on the signer or its balance. */
  probeAddress: string;
}

/** The chains' typed apis, the pool, the transfer that moves the CASH to People and the
 *  destination's execution fee: what every tier's sizing starts from. The pool is on the fee path
 *  on every tier; the stable pool tier's stable pool is found in the same read. */
export async function sizingReads(args: SizingArgs, stableAssetId?: number) {
  const api = args.ahClient.getTypedApi(paseo_next_v2);
  const peopleApi = args.peopleClient.getTypedApi(paseo_people_next);
  const [pools, transfer] = await Promise.all([
    discoverPools(
      api,
      stableAssetId === undefined
        ? [args.underlyingAssetId]
        : [args.underlyingAssetId, stableAssetId],
    ),
    chooseCashTransfer({
      assetHub: args.ahClient,
      people: args.peopleClient,
      assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
      peopleParaId: args.peopleParaId,
    }),
  ]);
  const pool: Pool = pools[0]!;
  const stablePool: Pool | undefined = pools[1];
  const destinationFee = await estimateDestinationFeeCash({
    peopleApi,
    pool,
    assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
    beneficiaryHex: ZERO_32,
    amount: args.settleAmount,
    transfer,
  });
  return { api, pool, stablePool, transfer, destinationFee };
}

/** The CASH a deposit already on the burner converts to on a route, and the figures a hand-off
 *  for exactly that deposit carries. */
export interface DepositValue {
  /** CASH that reaches the burner on People, base units, floored to the claim unit. */
  receive: bigint;
  remoteFeeBuffer: bigint;
  keepNativeForFees: bigint;
  /** The gate for the fixed-rate and fee-priced tiers: the deposit itself. */
  quotedDeposit?: bigint;
}

/** Claims are made in hundredths of a CASH, so a figure is floored to that before it is promised. */
const CLAIM_UNIT = 10_000n;

/** The stable a deposit leaves for the conversion once the fees and the min_balance come out of
 *  it: the reverse of `stableDepositNeeded`. */
const leftAfterFees = (deposit: bigint, fees: StableLegFees): bigint =>
  deposit -
  fees.minBalanceExternal -
  withFeeMargin(fees.dispatchExternal + fees.localExternal + fees.deliveryExternal);

/**
 * What a deposit that has already landed converts to on `route`: the reverse of each tier's
 * sizing, priced live. A short deposit or one in another token is continued at this figure, so it
 * is the gate's own arithmetic run backwards. The tiers that swap through a pool keep
 * `slippagePct` back from the quote, so the figure still clears when the pool moves a little
 * before the worker converts; anything above it lands as extra CASH. Null when the deposit does
 * not cover its own fees or the pool cannot price it.
 */
export async function quoteDepositValue(
  args: Omit<SizingArgs, "settleAmount"> & {
    route: ConversionRoute;
    deposit: bigint;
    slippagePct: number;
  },
): Promise<DepositValue | null> {
  const { route, deposit } = args;
  // The destination fee does not depend on the amount; the deposit stands in for it.
  const stableAssetId =
    route.tier === "pool" && route.external !== undefined
      ? STABLE_TOKENS[route.external].assetHubId
      : undefined;
  const { api, pool, stablePool, transfer, destinationFee } = await sizingReads(
    { ...args, settleAmount: deposit },
    stableAssetId,
  );
  const keepBack = (cash: bigint) =>
    (cash * BigInt(Math.round((100 - args.slippagePct) * 100))) / 10_000n;
  const earmark = destinationEarmark(deposit, destinationFee);
  const common = {
    api,
    beneficiaryHex: ZERO_32,
    peopleParaId: args.peopleParaId,
    remoteFeesCash: earmark,
    transfer,
    feeProbeAddress: args.probeAddress,
  };
  let reaches: bigint | null = null;
  let keepNativeForFees = 0n;
  let fixedGate = true;
  // A deposit under what the program keeps out for its own fees has nothing to convert.
  try {
    if (route.tier === "dotusd") {
      const fees = await estimateDotUsdProgramFees({ ...common, depositUnderlying: deposit });
      reaches = leftAfterFees(deposit, fees);
    } else if (route.tier === "psm") {
      const fees = await estimatePsmBatchFees({ ...common, route, depositExternal: deposit });
      const left = leftAfterFees(deposit, fees);
      reaches = left <= 0n ? null : psmMintOut(left, route.feeRate);
    } else if (stablePool !== undefined && route.external !== undefined) {
      const nativeForDeposit = await quoteNativeOut(api, stablePool, deposit);
      const fees = await estimateStableProgramFees({
        ...common,
        stable: route.external,
        stablePool,
        pool,
        depositStable: deposit,
        minNativeOut: nativeForDeposit ?? deposit,
        minUnderlyingOut: deposit,
      });
      const left = leftAfterFees(deposit, fees);
      const native = left <= 0n ? null : await quoteNativeOut(api, stablePool, left);
      const cash = native === null ? null : await quoteUnderlyingOut(api, pool, native);
      reaches = cash === null ? null : keepBack(cash);
    } else {
      const fees = await estimateFundingProgramFees({
        ...common,
        pool,
        nativeBalance: deposit,
        minUnderlyingOut: 1n,
      });
      keepNativeForFees = fees.payFeesNative + fees.dispatchNative;
      fixedGate = false;
      const spend = deposit - keepNativeForFees;
      const cash = spend <= 0n ? null : await quoteUnderlyingOut(api, pool, spend);
      reaches = cash === null ? null : keepBack(cash);
    }
  } catch (e) {
    if (e instanceof DepositBelowFeesError) return null;
    throw e;
  }
  if (reaches === null) return null;
  const receive = ((reaches - destinationFee) / CLAIM_UNIT) * CLAIM_UNIT;
  if (receive < CLAIM_UNIT) return null;
  return {
    receive,
    remoteFeeBuffer: destinationFee,
    keepNativeForFees,
    ...(fixedGate ? { quotedDeposit: deposit } : {}),
  };
}
