// Sizes the two fee allowances the deposit must carry, priced live from the chain with no funds
// and no stand-in account. keepNativeForFees is the native the deposit carries on top of the pool
// quote for the program's own costs: dispatch, local execution and delivery. remoteFeeBuffer is
// the extra underlying to over-buy for the destination's execution fee; an over-buy lands as extra
// coinage. Every figure is a runtime read against our own message. Any failure returns null and
// the caller keeps the funding package's static fallbacks.

import { paseo_next_v2 } from "@polkadot-api/descriptors";
import type { PolkadotClient } from "polkadot-api";
import {
  DEFAULT_SLIPPAGE_PCT,
  destinationEarmark,
  discoverPool,
  estimateFundingProgramFees,
  quoteNativeInMax,
} from "@getsome/funding";

export interface FundingSizing {
  /** Extra underlying to over-buy for the destination's execution fee. */
  remoteFeeBuffer: bigint;
  /** Native the deposit carries for the program's dispatch fee and fee allowance. */
  keepNativeForFees: bigint;
}

/** The destination fee over-buy: one claim unit, 0.01 at 6 decimals. The destination prices its
 *  execution only on arrival, so it cannot be measured here. The observed charge is tens of base
 *  units, and the surplus is delivered with the settle. */
const DESTINATION_BUFFER = 10_000n;

/** A throwaway 32-byte beneficiary for the fee reads; it does not affect any fee. */
const ZERO_32 = `0x${"00".repeat(32)}`;

export async function estimateFundingSizing(args: {
  ahClient: PolkadotClient;
  underlyingAssetId: number;
  peopleParaId: number;
  settleAmount: bigint;
  /** Any valid address; getEstimatedFees does not depend on the signer or its balance. */
  probeAddress: string;
}): Promise<FundingSizing | null> {
  try {
    const api = args.ahClient.getTypedApi(paseo_next_v2);
    const pool = await discoverPool(api, args.underlyingAssetId);

    // The fee probes carry the amounts a real deposit would, so the measured dispatch fee matches
    // the submitted call's length.
    const buyTarget = args.settleAmount + DESTINATION_BUFFER;
    const nativeInMax = await quoteNativeInMax(api, pool, buyTarget, DEFAULT_SLIPPAGE_PCT);

    const fees = await estimateFundingProgramFees({
      api,
      pool,
      beneficiaryHex: ZERO_32,
      peopleParaId: args.peopleParaId,
      nativeBalance: nativeInMax,
      minUnderlyingOut: buyTarget,
      remoteFeesCash: destinationEarmark(buyTarget, DESTINATION_BUFFER),
      feeProbeAddress: args.probeAddress,
    });

    return {
      remoteFeeBuffer: DESTINATION_BUFFER,
      keepNativeForFees: fees.payFeesNative + fees.dispatchNative,
    };
  } catch (e) {
    console.warn("[coinage] funding sizing estimate failed; using static fallbacks:", e);
    return null;
  }
}
