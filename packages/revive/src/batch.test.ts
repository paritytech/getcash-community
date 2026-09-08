import { describe, expect, it } from "vitest";
import type { ActionCall, SettlePlan } from "@getsome/core";
import { buildSpendBatch } from "./batch";
import { DEFAULT_WEIGHT, REVIVE_STORAGE_DEPOSIT, USDC_ASSET_ID } from "./constants";
import { localAssetLocation, nativeAssetLocation } from "./locations";

const PAYER = "5Ephemeral";
const DEST = "5UserConnected";

const CALL: ActionCall = {
  dest: "0xabc0000000000000000000000000000000000001",
  data: "0xdeadbeef",
};

const NATIVE: SettlePlan = { dest: DEST, settlement: { kind: "native" } };

describe("buildSpendBatch, Tier-1 native", () => {
  it("produces exactly [map_account, Revive.call, Balances.transfer_all], no feeAsset, finalized", () => {
    const batch = buildSpendBatch({ call: CALL, payer: PAYER, settle: NATIVE });

    expect(batch.calls.map((c) => `${c.pallet}.${c.call}`)).toEqual([
      "Revive.map_account",
      "Revive.call",
      "Balances.transfer_all",
    ]);
    expect(batch.feeAsset).toBeUndefined();
    expect(batch.waitFor).toBe("finalized");

    const [map, , sweep] = batch.calls;
    // map_account maps the caller (the payer); no accounts argument exists.
    expect(map).toEqual({ pallet: "Revive", call: "map_account" });
    expect(sweep).toEqual({
      pallet: "Balances",
      call: "transfer_all",
      args: { dest: DEST, keepAlive: false },
    });
  });

  it("scales value /10^8: 1 EVM unit (18-dec) -> 10_000_000_000n plancks (10-dec)", () => {
    const batch = buildSpendBatch({
      call: { ...CALL, value: 1_000_000_000_000_000_000n },
      payer: PAYER,
      settle: NATIVE,
    });
    const revive = batch.calls[1];
    if (revive?.pallet !== "Revive" || revive.call !== "call") throw new Error("shape");
    expect(revive.args.value).toBe(10_000_000_000n);
  });

  it("defaults value to 0n when the ActionCall omits it", () => {
    const batch = buildSpendBatch({ call: CALL, payer: PAYER, settle: NATIVE });
    const revive = batch.calls[1];
    if (revive?.pallet !== "Revive" || revive.call !== "call") throw new Error("shape");
    expect(revive.args.value).toBe(0n);
    expect(revive.args.dest).toBe(CALL.dest);
    expect(revive.args.data).toBe(CALL.data);
  });

  it("honors weightHint; falls back to DEFAULT_WEIGHT; storageDepositLimit is always 0.2 DOT", () => {
    const hint = { refTime: 123n, proofSize: 456n };
    const withHint = buildSpendBatch({
      call: { ...CALL, weightHint: hint },
      payer: PAYER,
      settle: NATIVE,
    });
    const withoutHint = buildSpendBatch({ call: CALL, payer: PAYER, settle: NATIVE });

    const hinted = withHint.calls[1];
    const defaulted = withoutHint.calls[1];
    if (hinted?.pallet !== "Revive" || hinted.call !== "call") throw new Error("shape");
    if (defaulted?.pallet !== "Revive" || defaulted.call !== "call") throw new Error("shape");

    expect(hinted.args.weightLimit).toEqual(hint);
    expect(defaulted.args.weightLimit).toEqual(DEFAULT_WEIGHT);
    expect(hinted.args.storageDepositLimit).toBe(REVIVE_STORAGE_DEPOSIT);
    expect(defaulted.args.storageDepositLimit).toBe(2_000_000_000n);
  });

  it("autoMap:false drops the map instruction (AutoMap chains only in v1; unmap reclaim out of scope)", () => {
    const batch = buildSpendBatch({ call: CALL, payer: PAYER, settle: NATIVE, autoMap: false });
    expect(batch.calls.map((c) => `${c.pallet}.${c.call}`)).toEqual([
      "Revive.call",
      "Balances.transfer_all",
    ]);
  });
});

describe("buildSpendBatch, Tier-2", () => {
  const quote = { amountOut: 5_000_000_000n, amountInMax: 12_000_000n };

  it("stable USDC: swap first, feeAsset local(1337), sweeps [Assets(1337), Balances] in that order", () => {
    const batch = buildSpendBatch({
      call: CALL,
      payer: PAYER,
      settle: { dest: DEST, settlement: { kind: "stable", asset: "USDC" } },
      swapQuote: quote,
    });

    expect(batch.calls.map((c) => `${c.pallet}.${c.call}`)).toEqual([
      "AssetConversion.swap_tokens_for_exact_tokens",
      "Revive.map_account",
      "Revive.call",
      "Assets.transfer_all",
      "Balances.transfer_all",
    ]);

    const swap = batch.calls[0];
    if (swap?.pallet !== "AssetConversion") throw new Error("shape");
    expect(swap.args).toEqual({
      path: [localAssetLocation(USDC_ASSET_ID), nativeAssetLocation()],
      amountOut: quote.amountOut,
      amountInMax: quote.amountInMax,
      sendTo: PAYER,
      keepAlive: false,
    });

    expect(batch.feeAsset).toEqual(localAssetLocation(1337));

    const assetSweep = batch.calls[3];
    if (assetSweep?.pallet !== "Assets") throw new Error("shape");
    expect(assetSweep.args).toEqual({ id: 1337, dest: DEST, keepAlive: false });
    expect(batch.waitFor).toBe("finalized");
  });

  it("stable USDT maps to asset id 1984", () => {
    const batch = buildSpendBatch({
      call: CALL,
      payer: PAYER,
      settle: { dest: DEST, settlement: { kind: "stable", asset: "USDT" } },
      swapQuote: quote,
    });
    expect(batch.feeAsset).toEqual(localAssetLocation(1984));
    const assetSweep = batch.calls[3];
    if (assetSweep?.pallet !== "Assets") throw new Error("shape");
    expect(assetSweep.args.id).toBe(1984);
  });

  it("pooled(7777): swap path + feeAsset + sweeps all use id 7777", () => {
    const batch = buildSpendBatch({
      call: CALL,
      payer: PAYER,
      settle: { dest: DEST, settlement: { kind: "pooled", assetId: 7777 } },
      swapQuote: quote,
    });

    const swap = batch.calls[0];
    if (swap?.pallet !== "AssetConversion") throw new Error("shape");
    expect(swap.args.path[0]).toEqual(localAssetLocation(7777));
    expect(swap.args.path[1]).toEqual(nativeAssetLocation());
    expect(batch.feeAsset).toEqual(localAssetLocation(7777));

    const tail = batch.calls.slice(-2).map((c) => `${c.pallet}.${c.call}`);
    expect(tail).toEqual(["Assets.transfer_all", "Balances.transfer_all"]);
  });

  it("throws when swapQuote is missing on a Tier-2 settlement", () => {
    expect(() =>
      buildSpendBatch({
        call: CALL,
        payer: PAYER,
        settle: { dest: DEST, settlement: { kind: "pooled", assetId: 7777 } },
      }),
    ).toThrow(/swapQuote/);
  });
});

// storageDepositHint: the cap is a hint-or-default, like weights.
import { describe as describe2, expect as expect2, it as it2 } from "vitest";
import { buildSpendBatch as build2 } from "./batch";
import { REVIVE_STORAGE_DEPOSIT as DEFAULT_DEPOSIT } from "./constants";

describe2("storageDepositHint", () => {
  const base = {
    call: { dest: "0xdead" as const, data: "0xbeef" as const },
    payer: "5Payer",
    settle: { dest: "5Recipient", settlement: { kind: "native" as const } },
  };

  it2("honors the hint as the storage_deposit_limit cap", () => {
    const batch = build2({
      ...base,
      call: { ...base.call, storageDepositHint: 123_000_000n },
    });
    const revive = batch.calls.find((c) => c.pallet === "Revive" && c.call === "call");
    expect2(revive && "storageDepositLimit" in revive.args && revive.args.storageDepositLimit).toBe(
      123_000_000n,
    );
  });

  it2("falls back to the conservative 0.2 DOT default when no hint is given", () => {
    const batch = build2(base);
    const revive = batch.calls.find((c) => c.pallet === "Revive" && c.call === "call");
    expect2(revive && "storageDepositLimit" in revive.args && revive.args.storageDepositLimit).toBe(
      DEFAULT_DEPOSIT,
    );
  });
});
