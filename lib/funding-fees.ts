// Sizes the fee allowances the deposit must carry, priced live from both chains with no funds and
// no stand-in account. Every figure is a runtime read against our own message. The two tiers'
// costs differ in composition, not just in value, so each has its
// own shape. On the pool tier, keepNativeForFees is the native the deposit carries on top of the
// pool quote for the program's own costs on Asset Hub, and any failure returns null so the caller
// keeps the funding package's static fallbacks. On the PSM tier the batch's dispatch fee and the
// XCM's own fees are both charged in the external, the latter from an allowance a tenth over the
// estimate that stays out of the mint with the external's min_balance and is refunded to the
// burner where unspent, and the PSM takes its fee on the mint; there is no static fallback,
// because the tier is only chosen once the chain has answered. remoteFeeBuffer is the same on
// both: the extra underlying to over-buy for the destination's execution fee, read from a dry run
// of the forwarded program on People, with the same tenth on top.

import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import type { PolkadotClient } from "polkadot-api";
import {
  DEFAULT_KEEP_NATIVE_FOR_FEES,
  DEFAULT_REMOTE_FEE_BUFFER,
  DEFAULT_SLIPPAGE_PCT,
  destinationEarmark,
  discoverPool,
  estimateDestinationFeeCash,
  estimateFundingProgramFees,
  estimatePsmBatchFees,
  PASEO_ASSET_HUB_PARA_ID,
  PASEO_PEOPLE_PARA_ID,
  PASEO_UNDERLYING_ASSET_ID,
  psmDepositNeeded,
  quoteNativeInMax,
  sizePsmMint,
  type PsmExternal,
  type PsmRoute,
  type Pool,
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

export type FundingSizing = PoolFundingSizing | PsmFundingSizing;

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

/** The chains' typed apis, the pool and the destination's execution fee: what both tiers' sizing
 *  starts from. The pool is on the fee path on both tiers. */
async function sizingReads(args: SizingArgs) {
  const api = args.ahClient.getTypedApi(paseo_next_v2);
  const peopleApi = args.peopleClient.getTypedApi(paseo_people_next);
  const pool: Pool = await discoverPool(api, args.underlyingAssetId);
  const destinationFee = await estimateDestinationFeeCash({
    peopleApi,
    pool,
    assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
    beneficiaryHex: ZERO_32,
    amount: args.settleAmount,
  });
  return { api, pool, destinationFee };
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
