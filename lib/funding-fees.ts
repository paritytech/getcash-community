// Sizes the deposit's fee allowances from live runtime fee reads: the extra underlying the
// teleport spends on its fees, and the native the burner keeps to dispatch the swap. Any failure
// returns null.

import { paseo_next_v2 } from "@polkadot-api/descriptors";
import type { PolkadotClient } from "polkadot-api";
import {
  buildSelfFundingTeleport,
  discoverPool,
  estimateTeleportFeesCash,
  reserveForDispatchFee,
} from "@getsome/funding";

export interface FundingSizing {
  /** Extra underlying to buy for the fees the teleport pays in the underlying: its PayFees
   *  earmark and its own dispatch fee. */
  remoteFeeBuffer: bigint;
  /** Native the burner keeps to dispatch the swap. */
  keepNativeForFees: bigint;
}

/** Margin on the native dispatch reserve, ×1.2. */
const KEEP_MARGIN_NUM = 6n;
const KEEP_MARGIN_DEN = 5n;

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

    // The teleport's in-CASH fees (local + delivery), fund-free.
    const fees = await estimateTeleportFeesCash({
      api,
      pool,
      beneficiaryHex: ZERO_32,
      peopleParaId: args.peopleParaId,
      amount: args.settleAmount,
    });

    // The teleport's own dispatch fee, also paid in the underlying.
    const dispatchCash = await reserveForDispatchFee({
      api,
      pool,
      execArgs: buildSelfFundingTeleport({
        pool,
        withdrawAmount: args.settleAmount,
        payFeesCash: fees.payFeesCash,
        remoteFeesCash: fees.payFeesCash,
        beneficiaryHex: ZERO_32,
        peopleParaId: args.peopleParaId,
        maxWeight: fees.maxWeight,
      }),
      from: args.probeAddress,
    });

    // The swap's native dispatch fee, from a representative call: the fee depends on the call
    // shape, not the amounts or the signer.
    const swapTx = api.tx.AssetConversion.swap_exact_tokens_for_tokens({
      path: [pool.native, pool.underlying],
      amount_in: 10_000_000_000n,
      amount_out_min: 0n,
      send_to: args.probeAddress,
      keep_alive: false,
    });
    const swapFee = await swapTx.getEstimatedFees(args.probeAddress);

    return {
      remoteFeeBuffer: fees.payFeesCash + dispatchCash,
      keepNativeForFees: (swapFee * KEEP_MARGIN_NUM) / KEEP_MARGIN_DEN,
    };
  } catch (e) {
    console.warn("[coinage] funding sizing estimate failed; using static fallbacks:", e);
    return null;
  }
}
