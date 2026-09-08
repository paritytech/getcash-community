// Settle-back drain rules: native settlement is one Balances sweep; asset settlement is
// Assets.transfer_all followed by Balances.transfer_all.

import type { SettlementAsset } from "@getsome/core";
import { USDC_ASSET_ID, USDT_ASSET_ID } from "./constants";
import type { BatchInstruction, SpendBatch } from "./ir";

/** The Assets-pallet id a settlement drains through; null for native (no asset sweep). */
export function settlementAssetId(settlement: SettlementAsset): number | null {
  switch (settlement.kind) {
    case "native":
      return null;
    case "stable":
      return settlement.asset === "USDC" ? USDC_ASSET_ID : USDT_ASSET_ID;
    case "pooled":
      return settlement.assetId;
    case "foreign":
      // Foreign (Location-keyed) assets are swept by the owning chain's port.
      throw new Error(`cannot build an Asset Hub sweep for foreign asset '${settlement.id}'`);
  }
}

/** The ordered sweep tail shared by the spend batch and the standalone drain. */
export function sweepInstructions(dest: string, settlement: SettlementAsset): BatchInstruction[] {
  const calls: BatchInstruction[] = [];
  const id = settlementAssetId(settlement);
  if (id !== null) {
    calls.push({ pallet: "Assets", call: "transfer_all", args: { id, dest, keepAlive: false } });
  }
  calls.push({ pallet: "Balances", call: "transfer_all", args: { dest, keepAlive: false } });
  return calls;
}

/** Standalone drain (cancel / resume-'sweeping' paths): no map, no call, always finalized. */
export function buildSweepBatch(dest: string, settlement: SettlementAsset): SpendBatch {
  return { calls: sweepInstructions(dest, settlement), waitFor: "finalized" };
}
