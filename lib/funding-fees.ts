// Sizes the fee allowances the deposit must carry, priced live from both chains with no funds and
// no stand-in account. Every figure is a runtime read against our own message. The two tiers'
// costs differ in composition, not just in value, so each has its
// own shape. On the pool tier, keepNativeForFees is the native the deposit carries on top of the
// pool quote for the program's own costs on Asset Hub, and any failure returns null so the caller
// keeps the funding package's static fallbacks. On the PSM tier the batch's dispatch fee and the
// XCM's own fees are both charged in the external, the latter from an allowance a tenth over the
// estimate that stays out of the mint with the external's min_balance and is refunded to the
// burner where unspent, and the PSM takes its fee on the mint; there is no static fallback,
// because the tier is only chosen once the chain has answered. The stable pool tier's fees have
// the PSM tier's shape, with the two-hop pool quote in place of the mint; the teleport tier's
// have it too, with nothing in place of the mint, since the deposit is the underlying itself.
// remoteFeeBuffer is the same on every tier: the extra underlying to over-buy for the
// destination's execution fee, read from a dry run of the forwarded program on People, with the
// same tenth on top.

import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import type { PolkadotClient } from "polkadot-api";
import {
  DEFAULT_KEEP_NATIVE_FOR_FEES,
  DEFAULT_REMOTE_FEE_BUFFER,
  DEFAULT_SLIPPAGE_PCT,
  DepositBelowFeesError,
  destinationEarmark,
  discoverPools,
  estimateDestinationFeeCash,
  estimateFundingProgramFees,
  estimatePsmBatchFees,
  estimateStableProgramFees,
  estimateTeleportProgramFees,
  PASEO_ASSET_HUB_PARA_ID,
  PASEO_PEOPLE_PARA_ID,
  PASEO_UNDERLYING_ASSET_ID,
  psmDepositNeeded,
  psmMintOut,
  quoteNativeInMax,
  quoteNativeOut,
  quoteStableForUnderlying,
  quoteUnderlyingOut,
  sizePsmMint,
  STABLE_TOKENS,
  stableDepositNeeded,
  withFeeMargin,
  type ConversionRoute,
  type PsmExternal,
  type PsmRoute,
  type Pool,
  type Stable,
  type StableLegFees,
  type StablePoolRoute,
  withHeadroom,
} from "@getsome/funding";

/** The pool tier's costs. */
export interface PoolFundingSizing {
  tier: "pool";
  /** Extra underlying to over-buy for the destination's execution fee. */
  remoteFeeBuffer: bigint;
  /** Native the deposit carries for the program's dispatch fee and fee allowance. */
  keepNativeForFees: bigint;
}

/** The PSM tier's costs. */
export interface PsmFundingSizing {
  tier: "psm";
  /** Extra underlying to over-buy for the destination's execution fee. */
  remoteFeeBuffer: bigint;
  /** The external the burner holds and the batch's dispatch fee is charged in. */
  external: PsmExternal;
  /** The dispatch fee, in the external, kept out of the mint. */
  dispatchExternal: bigint;
  /** Also kept out of the mint, in the external: the asset's min_balance, which the burner's
   *  account must hold to survive the batch and which stays on it, plus `feeAllowanceExternal`. */
  heldBackExternal: bigint;
  /** The allowance for the XCM's local execution and delivery, in the external: what the one
   *  cushion over the fees leaves after the dispatch fee, the unspent part refunded to the burner
   *  on Asset Hub. */
  feeAllowanceExternal: bigint;
  /** The PSM's fee on the mint, Permill, as the route recorded it. */
  feeRate: number;
  /** What the buyer is asked to deposit: the mint's input, the min_balance, and the cushioned
   *  fees. The worker's gate checks for this figure rather than re-pricing it. */
  quotedDeposit: bigint;
}

/** The stable pool tier's costs: the PSM tier's shape without the mint. */
export interface StablePoolFundingSizing {
  tier: "pool";
  /** The stable the burner holds and the program's dispatch fee is charged in. */
  external: Stable;
  /** Extra underlying to over-buy for the destination's execution fee. */
  remoteFeeBuffer: bigint;
  /** The dispatch fee, in the stable, kept out of the conversion. */
  dispatchExternal: bigint;
  /** Also kept out of the conversion, in the stable: the asset's min_balance, which the burner's
   *  account must hold to survive the program and which stays on it, plus
   *  `feeAllowanceExternal`. */
  heldBackExternal: bigint;
  /** The allowance for the XCM's local execution and delivery, in the stable, the unspent part
   *  refunded to the burner on Asset Hub. */
  feeAllowanceExternal: bigint;
  /** The gate the worker waits for, carried in the hand-off: the plain two-hop quote for the
   *  target, the min_balance, and the cushioned fees. */
  quotedDeposit: bigint;
  /** What the buyer is asked to deposit: the same with DEFAULT_SLIPPAGE_PCT on the quote, once. */
  askedDeposit: bigint;
}

/** The teleport tier's costs: the PSM tier's shape without the mint, the deposit being the
 *  underlying itself. */
export interface TeleportFundingSizing {
  tier: "teleport";
  /** Extra underlying to send along for the destination's execution fee. */
  remoteFeeBuffer: bigint;
  /** The dispatch fee, in the underlying, kept out of the send. */
  dispatchExternal: bigint;
  /** Also kept out of the send: the asset's min_balance, which the burner's account must hold to
   *  survive the program and which stays on it, plus `feeAllowanceExternal`. */
  heldBackExternal: bigint;
  /** The allowance for the XCM's local execution and delivery, in the underlying, the unspent
   *  part refunded to the burner on Asset Hub. */
  feeAllowanceExternal: bigint;
  /** What the buyer is asked to deposit: the target, the min_balance and the cushioned fees.
   *  The worker's gate checks for this figure rather than re-pricing it. */
  quotedDeposit: bigint;
}

export type FundingSizing =
  PoolFundingSizing | StablePoolFundingSizing | PsmFundingSizing | TeleportFundingSizing;

/** A throwaway 32-byte beneficiary for the fee reads; it does not affect any fee. */
const ZERO_32 = `0x${"00".repeat(32)}`;

interface SizingArgs {
  ahClient: PolkadotClient;
  peopleClient: PolkadotClient;
  underlyingAssetId: number;
  peopleParaId: number;
  settleAmount: bigint;
  /** Any valid address; getEstimatedFees does not depend on the signer or its balance. */
  probeAddress: string;
}

/** The chains' typed apis, the pool and the destination's execution fee: what every tier's sizing
 *  starts from. The pool is on the fee path on every tier; the stable pool tier's stable pool is
 *  found in the same read. */
async function sizingReads(args: SizingArgs, stableAssetId?: number) {
  const api = args.ahClient.getTypedApi(paseo_next_v2);
  const peopleApi = args.peopleClient.getTypedApi(paseo_people_next);
  const pools = await discoverPools(
    api,
    stableAssetId === undefined
      ? [args.underlyingAssetId]
      : [args.underlyingAssetId, stableAssetId],
  );
  const pool: Pool = pools[0]!;
  const stablePool: Pool | undefined = pools[1];
  const destinationFee = await estimateDestinationFeeCash({
    peopleApi,
    pool,
    assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
    beneficiaryHex: ZERO_32,
    amount: args.settleAmount,
  });
  return { api, pool, stablePool, destinationFee };
}

/** The pool tier's sizing. */
export async function estimateFundingSizing(args: SizingArgs): Promise<PoolFundingSizing | null> {
  try {
    const { api, pool, destinationFee } = await sizingReads(args);

    // The fee probes carry the amounts a real deposit would, so the measured dispatch fee matches
    // the submitted call's length.
    const buyTarget = args.settleAmount + destinationFee;
    const nativeInMax = await quoteNativeInMax(api, pool, buyTarget, DEFAULT_SLIPPAGE_PCT);

    const fees = await estimateFundingProgramFees({
      api,
      pool,
      beneficiaryHex: ZERO_32,
      peopleParaId: args.peopleParaId,
      nativeBalance: nativeInMax,
      minUnderlyingOut: buyTarget,
      remoteFeesCash: destinationEarmark(buyTarget, destinationFee),
      feeProbeAddress: args.probeAddress,
    });

    return {
      tier: "pool",
      remoteFeeBuffer: destinationFee,
      keepNativeForFees: fees.payFeesNative + fees.dispatchNative,
    };
  } catch (e) {
    console.warn("[coinage] funding sizing estimate failed; using static fallbacks:", e);
    return null;
  }
}

/** The PSM tier's sizing: the batch's own fees, measured against the batch that mints the settle
 *  amount plus the destination fee. Throws when a read fails; the pipeline has no static figures
 *  for this tier either (`DEFAULT_KEEP_NATIVE_FOR_FEES`). */
export async function estimatePsmFundingSizing(
  args: SizingArgs & { route: PsmRoute },
): Promise<PsmFundingSizing> {
  const { api, destinationFee } = await sizingReads(args);
  const buyTarget = args.settleAmount + destinationFee;
  // At the magnitude the batch will carry, as the pool tier's probes do; the few cents the fees
  // add on top do not change the encoded lengths.
  const fees = await estimatePsmBatchFees({
    api,
    route: args.route,
    beneficiaryHex: ZERO_32,
    peopleParaId: args.peopleParaId,
    depositExternal: sizePsmMint(buyTarget, args.route).externalIn,
    remoteFeesCash: destinationEarmark(buyTarget, destinationFee),
    feeProbeAddress: args.probeAddress,
  });
  return {
    tier: "psm",
    remoteFeeBuffer: destinationFee,
    external: args.route.external,
    dispatchExternal: fees.dispatchExternal,
    heldBackExternal: fees.heldBackExternal,
    feeAllowanceExternal: fees.feeAllowanceExternal,
    feeRate: args.route.feeRate,
    quotedDeposit: psmDepositNeeded(buyTarget, args.route, fees),
  };
}

/** The stable pool tier's sizing: the program's own fees, measured against the program that
 *  converts the settle amount plus the destination fee. Throws when a read fails, as the PSM
 *  tier's does. */
export async function estimateStableFundingSizing(
  args: SizingArgs & {
    route: StablePoolRoute;
    /** The headroom on the ask, percent. Default DEFAULT_SLIPPAGE_PCT. */
    slippagePct?: number;
  },
): Promise<StablePoolFundingSizing> {
  const stable = args.route.external;
  const { api, pool, stablePool, destinationFee } = await sizingReads(
    args,
    STABLE_TOKENS[stable].assetHubId,
  );
  if (stablePool === undefined) throw new Error(`no native pool found for ${stable}`);
  const buyTarget = args.settleAmount + destinationFee;
  // The plain two-hop quote is the gate; the ask carries the headroom once, on the stable.
  const { stableIn } = await quoteStableForUnderlying(api, pool, stablePool, buyTarget);
  const stableInMax = withHeadroom(stableIn, args.slippagePct ?? DEFAULT_SLIPPAGE_PCT);
  // At the magnitude the program will carry, as the other tiers' probes do.
  const fees = await estimateStableProgramFees({
    api,
    stable,
    stablePool,
    pool,
    beneficiaryHex: ZERO_32,
    peopleParaId: args.peopleParaId,
    depositStable: stableInMax,
    minUnderlyingOut: buyTarget,
    remoteFeesCash: destinationEarmark(buyTarget, destinationFee),
    feeProbeAddress: args.probeAddress,
  });
  return {
    tier: "pool",
    external: stable,
    remoteFeeBuffer: destinationFee,
    dispatchExternal: fees.dispatchExternal,
    heldBackExternal: fees.heldBackExternal,
    feeAllowanceExternal: fees.feeAllowanceExternal,
    quotedDeposit: stableDepositNeeded(stableIn, fees),
    askedDeposit: stableDepositNeeded(stableInMax, fees),
  };
}

/** The teleport tier's sizing: the program's own fees, measured against the program that sends
 *  the settle amount plus the destination fee. Throws when a read fails, as the PSM tier's does. */
export async function estimateTeleportFundingSizing(
  args: SizingArgs,
): Promise<TeleportFundingSizing> {
  const { api, destinationFee } = await sizingReads(args);
  const buyTarget = args.settleAmount + destinationFee;
  // At the magnitude the program will carry, as the other tiers' probes do.
  const fees = await estimateTeleportProgramFees({
    api,
    beneficiaryHex: ZERO_32,
    peopleParaId: args.peopleParaId,
    depositUnderlying: buyTarget,
    remoteFeesCash: destinationEarmark(buyTarget, destinationFee),
    feeProbeAddress: args.probeAddress,
  });
  return {
    tier: "teleport",
    remoteFeeBuffer: destinationFee,
    dispatchExternal: fees.dispatchExternal,
    heldBackExternal: fees.heldBackExternal,
    feeAllowanceExternal: fees.feeAllowanceExternal,
    quotedDeposit: stableDepositNeeded(buyTarget, fees),
  };
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
  const { api, pool, stablePool, destinationFee } = await sizingReads(
    { ...args, settleAmount: deposit },
    stableAssetId,
  );
  const keepBack = (cash: bigint) => (cash * BigInt(100 - args.slippagePct)) / 100n;
  const earmark = destinationEarmark(deposit, destinationFee);
  const common = {
    api,
    beneficiaryHex: ZERO_32,
    peopleParaId: args.peopleParaId,
    remoteFeesCash: earmark,
    feeProbeAddress: args.probeAddress,
  };
  let reaches: bigint | null = null;
  let keepNativeForFees = 0n;
  let fixedGate = true;
  // A deposit under what the program keeps out for its own fees has nothing to convert.
  try {
    if (route.tier === "teleport") {
      const fees = await estimateTeleportProgramFees({ ...common, depositUnderlying: deposit });
      reaches = leftAfterFees(deposit, fees);
    } else if (route.tier === "psm") {
      const fees = await estimatePsmBatchFees({ ...common, route, depositExternal: deposit });
      const left = leftAfterFees(deposit, fees);
      reaches = left <= 0n ? null : psmMintOut(left, route.feeRate);
    } else if (stablePool !== undefined && route.external !== undefined) {
      const fees = await estimateStableProgramFees({
        ...common,
        stable: route.external,
        stablePool,
        pool,
        depositStable: deposit,
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

/** The funding package's static sizing, as the pool tier's callers fall back to it. */
export const FALLBACK_FUNDING_SIZING: PoolFundingSizing = {
  tier: "pool",
  remoteFeeBuffer: DEFAULT_REMOTE_FEE_BUFFER,
  keepNativeForFees: DEFAULT_KEEP_NATIVE_FOR_FEES,
};

/**
 * The pool tier's sizing over the shared public clients, on the chain ids this deployment funds
 * against.
 *
 * The mock quote paths' single entry point: those price the pool tier, the only one the mock world
 * takes. It never rejects and never returns null, so a caller that only needs figures to price
 * with can use the result directly. An unreachable chain leaves the static fallbacks, the same
 * ones the worker itself falls back to.
 */
export async function estimatePublicFundingSizing(args: {
  settleAmount: bigint;
  probeAddress: string;
}): Promise<PoolFundingSizing> {
  try {
    const { connectChain, ASSET_HUB, PEOPLE } = await import("./host-chain");
    const [ahClient, peopleClient] = await Promise.all([
      connectChain(ASSET_HUB),
      connectChain(PEOPLE),
    ]);
    return (
      (await estimateFundingSizing({
        ahClient,
        peopleClient,
        underlyingAssetId: PASEO_UNDERLYING_ASSET_ID,
        peopleParaId: PASEO_PEOPLE_PARA_ID,
        settleAmount: args.settleAmount,
        probeAddress: args.probeAddress,
      })) ?? FALLBACK_FUNDING_SIZING
    );
  } catch (e) {
    console.warn("[coinage] funding sizing unreachable; using static fallbacks:", e);
    return FALLBACK_FUNDING_SIZING;
  }
}
