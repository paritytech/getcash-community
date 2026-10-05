// The teleport tier's program over a recording Asset Hub api: the five instructions, every fee
// read keyed by dotUSD, the margin it carries and the min_balance it holds back, and the reasons
// it refuses.

import { TOKENS } from "@getsome/core";
import { describe, expect, it } from "vitest";
import {
  buildTeleportFundingProgram,
  DepositBelowFeesError,
  estimateTeleportProgramFees,
  peopleDest,
  teleportTxOptions,
  withFeeMargin,
} from "./funding-program";

type Instruction = { type: string; value: unknown };
type Fungible = { id: unknown; fun: { type: string; value: bigint } };
type ExecuteArgs = { message: { value: Instruction[] }; max_weight: unknown };

const PEOPLE_PARA = 1502;
const BENEFICIARY_HEX = `0x${"07".repeat(32)}`;
const PROGRAM = {
  withdrawUnderlying: 5_100_000n,
  payFeesUnderlying: 88_605n,
  remoteFeesCash: 50_000n,
  beneficiaryHex: BENEFICIARY_HEX,
  peopleParaId: PEOPLE_PARA,
  transfer: "teleport" as const,
  maxWeight: { ref_time: 5n, proof_size: 6n },
};

const instruction = (args: ExecuteArgs, type: string) =>
  args.message.value.find((i) => i.type === type)?.value as never;

describe("buildTeleportFundingProgram", () => {
  const args = buildTeleportFundingProgram(PROGRAM) as unknown as ExecuteArgs;

  it("withdraws dotUSD, pays the fees in it, teleports the rest, refunds the surplus, with no exchange", () => {
    expect(args.message.value.map((i) => i.type)).toEqual([
      "WithdrawAsset",
      "PayFees",
      "InitiateTransfer",
      "RefundSurplus",
      "DepositAsset",
    ]);
    expect(instruction(args, "WithdrawAsset")).toEqual([
      { id: TOKENS.DOTUSD.location, fun: { type: "Fungible", value: PROGRAM.withdrawUnderlying } },
    ]);
    expect((instruction(args, "PayFees") as { asset: Fungible }).asset).toEqual({
      id: TOKENS.DOTUSD.location,
      fun: { type: "Fungible", value: PROGRAM.payFeesUnderlying },
    });
    const transfer = instruction(args, "InitiateTransfer") as {
      destination: unknown;
      remote_fees: { value: { value: Fungible[] } };
      remote_xcm: Instruction[];
    };
    expect(transfer.destination).toEqual(peopleDest(PEOPLE_PARA));
    expect(transfer.remote_fees.value.value[0]).toEqual({
      id: TOKENS.CASH.location,
      fun: { type: "Fungible", value: PROGRAM.remoteFeesCash },
    });
    expect(transfer.remote_xcm.map((i) => i.type)).toEqual(["RefundSurplus", "DepositAsset"]);
    expect(args.max_weight).toEqual(PROGRAM.maxWeight);
  });

  it("charges the dispatch fee in dotUSD", () => {
    expect(teleportTxOptions()).toEqual({ asset: TOKENS.DOTUSD.location });
  });
});

/** An Asset Hub api that records the fee reads the estimate makes. */
function recordingApi(
  opts: { minBalance?: bigint | undefined; dispatchExternal?: bigint | undefined } = {},
) {
  const seen: {
    assetRead?: unknown;
    localFeeAsset?: unknown;
    deliveryAsset?: unknown;
    feeOptions?: unknown;
    quote?: unknown[];
    executed: ExecuteArgs[];
  } = { executed: [] };
  const api = {
    query: {
      Assets: {
        Asset: {
          getValue: async (id: unknown) => {
            seen.assetRead = id;
            const minBalance = "minBalance" in opts ? opts.minBalance : 1n;
            return minBalance === undefined ? undefined : { min_balance: minBalance };
          },
        },
      },
    },
    tx: {
      PolkadotXcm: {
        execute: (args: ExecuteArgs) => {
          seen.executed.push(args);
          return {
            decodedCall: { type: "PolkadotXcm", value: { type: "execute", value: args } },
            getEstimatedFees: async (_from: unknown, options: unknown) => {
              seen.feeOptions = options;
              return 17_910_000n;
            },
          };
        },
      },
    },
    apis: {
      XcmPaymentApi: {
        query_xcm_weight: async () => ({
          success: true,
          value: { ref_time: 2_904_318_000n, proof_size: 23_335n },
        }),
        query_weight_to_asset_fee: async (_weight: unknown, asset: unknown) => {
          seen.localFeeAsset = asset;
          return { success: true, value: 5_095n };
        },
        query_delivery_fees: async (_dest: unknown, _message: unknown, asset: unknown) => {
          seen.deliveryAsset = asset;
          return {
            success: true,
            value: { value: [{ fun: { type: "Fungible", value: 75_455n } }] },
          };
        },
      },
      AssetConversionApi: {
        quote_price_tokens_for_exact_tokens: async (...args: unknown[]) => {
          seen.quote = args;
          return "dispatchExternal" in opts ? opts.dispatchExternal : 4_435n;
        },
      },
    },
  };
  return { api: api as never, seen };
}

describe("estimateTeleportProgramFees", () => {
  const input = {
    beneficiaryHex: BENEFICIARY_HEX,
    peopleParaId: PEOPLE_PARA,
    depositUnderlying: 5_143_041n,
    remoteFeesCash: 50_000n,
    transfer: "teleport" as const,
    feeProbeAddress: "5Probe",
  };

  it("prices execution, delivery and the dispatch in dotUSD, as measured on Paseo, and holds back min_balance plus the cushioned allowance", async () => {
    const { api, seen } = recordingApi();
    const fees = await estimateTeleportProgramFees({ api, ...input });
    expect(seen.assetRead).toBe(TOKENS.DOTUSD.assetHubId);
    const asset = { type: "V5", value: TOKENS.DOTUSD.location };
    expect(seen.localFeeAsset).toEqual(asset);
    expect(seen.deliveryAsset).toEqual(asset);
    expect(seen.feeOptions).toEqual({ asset: TOKENS.DOTUSD.location });
    expect(seen.quote).toEqual([TOKENS.DOTUSD.location, TOKENS.PAS.location, 17_910_000n, true]);
    // Every call it prices or dry-runs declares the weighed weight, never the fallback ceiling.
    for (const args of seen.executed) {
      expect(args.max_weight).toEqual({ ref_time: 2_904_318_000n, proof_size: 23_335n });
    }
    expect(fees).toEqual({
      localExternal: 5_095n,
      deliveryExternal: 75_455n,
      feeAllowanceExternal: withFeeMargin(5_095n + 75_455n),
      minBalanceExternal: 1n,
      heldBackExternal: 1n + withFeeMargin(5_095n + 75_455n),
      dispatchNative: 17_910_000n,
      dispatchExternal: 4_435n,
      maxWeight: { ref_time: 2_904_318_000n, proof_size: 23_335n },
    });
  });

  it("refuses a deposit that does not cover what is held back, an asset Asset Hub does not know, and an unpriceable dispatch", async () => {
    await expect(
      estimateTeleportProgramFees({ api: recordingApi().api, ...input, depositUnderlying: 1n }),
    ).rejects.toThrow(/does not cover/);
    await expect(
      estimateTeleportProgramFees({ api: recordingApi().api, ...input, depositUnderlying: 1n }),
    ).rejects.toBeInstanceOf(DepositBelowFeesError);
    await expect(
      estimateTeleportProgramFees({ api: recordingApi({ minBalance: undefined }).api, ...input }),
    ).rejects.toThrow(/not an asset/);
    await expect(
      estimateTeleportProgramFees({
        api: recordingApi({ dispatchExternal: undefined }).api,
        ...input,
      }),
    ).rejects.toThrow(/cannot price the dispatch fee/);
  });
});
