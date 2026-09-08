// The batch IR: a pure, papi-free description of the atomic Utility.batch_all. The papi
// binding maps each instruction to a real tx.

import type { XcmLocation } from "./locations";

export type Hex = `0x${string}`;

export interface WeightLimit {
  refTime: bigint;
  proofSize: bigint;
}

export type BatchInstruction =
  // map_account maps the caller (the payer signs the batch), hence no accounts argument.
  | { pallet: "Revive"; call: "map_account" }
  | {
      pallet: "Revive";
      call: "call";
      args: {
        dest: Hex;
        /** Chain 10-dec plancks, already scaled /10^8 from the ActionCall's EVM 18-dec value. */
        value: bigint;
        weightLimit: WeightLimit;
        storageDepositLimit: bigint;
        data: Hex;
      };
    }
  | { pallet: "Balances"; call: "transfer_all"; args: { dest: string; keepAlive: boolean } }
  | {
      pallet: "Assets";
      call: "transfer_all";
      args: { id: number; dest: string; keepAlive: boolean };
    }
  | {
      pallet: "AssetConversion";
      call: "swap_tokens_for_exact_tokens";
      args: {
        path: XcmLocation[];
        amountOut: bigint;
        amountInMax: bigint;
        sendTo: string;
        keepAlive: boolean;
      };
    };

export interface SpendBatch {
  calls: BatchInstruction[];
  /** ChargeAssetTxPayment fee-in-token location (Tier-2 only). */
  feeAsset?: XcmLocation;
  waitFor: "finalized" | "best-block";
}
