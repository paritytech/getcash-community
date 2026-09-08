import { describe, expect, it } from "vitest";
import { buildSweepBatch, settlementAssetId } from "./sweep";

const DEST = "5UserConnected";

describe("buildSweepBatch (standalone drain)", () => {
  it("native: single Balances.transfer_all, finalized, no feeAsset", () => {
    const batch = buildSweepBatch(DEST, { kind: "native" });
    expect(batch).toEqual({
      calls: [{ pallet: "Balances", call: "transfer_all", args: { dest: DEST, keepAlive: false } }],
      waitFor: "finalized",
    });
    expect(batch.feeAsset).toBeUndefined();
  });

  it("asset (stable USDC): two-sweep drain, Assets first, Balances last", () => {
    const batch = buildSweepBatch(DEST, { kind: "stable", asset: "USDC" });
    expect(batch.calls).toEqual([
      { pallet: "Assets", call: "transfer_all", args: { id: 1337, dest: DEST, keepAlive: false } },
      { pallet: "Balances", call: "transfer_all", args: { dest: DEST, keepAlive: false } },
    ]);
    expect(batch.waitFor).toBe("finalized");
  });

  it("asset (pooled 7777): same two-sweep order with the pooled id", () => {
    const batch = buildSweepBatch(DEST, { kind: "pooled", assetId: 7777 });
    expect(batch.calls).toEqual([
      { pallet: "Assets", call: "transfer_all", args: { id: 7777, dest: DEST, keepAlive: false } },
      { pallet: "Balances", call: "transfer_all", args: { dest: DEST, keepAlive: false } },
    ]);
  });

  it("foreign settlements cannot be swept through the Asset Hub batch (owning-chain port, G5)", () => {
    expect(() => settlementAssetId({ kind: "foreign", id: "cash" })).toThrow(/foreign/);
  });
});
