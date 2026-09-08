// The atomic spend batch: the priced contract call plus its swap path, expressed as a
// pure IR. Order (fixed):
//   [swap (Tier-2)] -> [map_account] -> Revive.call -> [Assets sweep (Tier-2)] -> Balances sweep.

import type { ActionCall, SettlePlan } from "@getsome/core";
import { DEFAULT_WEIGHT, EVM_CHAIN_DECIMAL_DIFF, REVIVE_STORAGE_DEPOSIT } from "./constants";
import type { BatchInstruction, SpendBatch } from "./ir";
import { localAssetLocation, nativeAssetLocation } from "./locations";
import { settlementAssetId, sweepInstructions } from "./sweep";

export interface SpendBatchInput {
  call: ActionCall;
  /** Ephemeral SS58: pays, receives the swap output, gets mapped. */
  payer: string;
  settle: SettlePlan;
  /** Default true. Adds the map_account instruction. */
  autoMap?: boolean;
  /** AssetConversion reverse-quote output; required on Tier-2 (stable/pooled). */
  swapQuote?: { amountOut: bigint; amountInMax: bigint };
}

export function buildSpendBatch(input: SpendBatchInput): SpendBatch {
  const { call, payer, settle, swapQuote } = input;
  const autoMap = input.autoMap ?? true;
  const calls: BatchInstruction[] = [];

  // a. Tier-2: swap token -> DOT first and pay the tx fee in-token.
  const assetId = settlementAssetId(settle.settlement);
  let feeAsset: SpendBatch["feeAsset"];
  if (assetId !== null) {
    if (!swapQuote) {
      throw new Error(
        "buildSpendBatch: swapQuote is required for stable/pooled (Tier-2) settlement",
      );
    }
    calls.push({
      pallet: "AssetConversion",
      call: "swap_tokens_for_exact_tokens",
      args: {
        path: [localAssetLocation(assetId), nativeAssetLocation()],
        amountOut: swapQuote.amountOut,
        amountInMax: swapQuote.amountInMax,
        sendTo: payer,
        keepAlive: false,
      },
    });
    feeAsset = localAssetLocation(assetId);
  }

  // b. Map the ephemeral. map_account maps the caller, which is the payer.
  if (autoMap) {
    calls.push({ pallet: "Revive", call: "map_account" });
  }

  // c. The priced call. Value crosses the Revive boundary scaled /10^8; storage_deposit_limit
  //    is a cap, not a charge.
  calls.push({
    pallet: "Revive",
    call: "call",
    args: {
      dest: call.dest,
      value: (call.value ?? 0n) / 10n ** EVM_CHAIN_DECIMAL_DIFF,
      weightLimit: call.weightHint ?? { ...DEFAULT_WEIGHT },
      storageDepositLimit: call.storageDepositHint ?? REVIVE_STORAGE_DEPOSIT,
      data: call.data,
    },
  });

  // d. Settle-back sweeps, asset first, native last.
  calls.push(...sweepInstructions(settle.dest, settle.settlement));

  // In-batch sweep; wait for finalization.
  return { calls, feeAsset, waitFor: "finalized" };
}
