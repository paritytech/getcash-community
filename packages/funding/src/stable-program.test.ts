// The stable pool tier's program over a recording Asset Hub api: the seven instructions and their
// filters, the fee estimate's asset on every read, the margin it carries and the min_balance it
// holds back, the dry run it asks for the real forwarded program, and the reasons it refuses.

import { TOKENS } from "@getsome/core";
import { describe, expect, it } from "vitest";
import {
  buildStableFundingProgram,
  estimateStableProgramFees,
  forwardedProgramStandIn,
  FUNDING_PROGRAM_MAX_WEIGHT,
  peopleDest,
  withFeeMargin,
  type Pool,
} from "./funding-program";

type Instruction = { type: string; value: unknown };
type Fungible = { id: unknown; fun: { type: string; value: bigint } };
type ExecuteArgs = { message: { value: Instruction[] }; max_weight: unknown };

const PEOPLE_PARA = 1502;
const BENEFICIARY_HEX = `0x${"07".repeat(32)}`;
const NATIVE_LOC = { parents: 1, interior: { type: "Here" } };
const STABLE_POOL = { native: NATIVE_LOC, underlying: TOKENS.USDC.location } as unknown as Pool;
const POOL = { native: NATIVE_LOC, underlying: TOKENS.CASH.location } as unknown as Pool;
/** USDC's min_balance on Paseo Asset Hub Next, as the scripted chain answers it. */
const MIN_BALANCE = 70_000n;
const PROGRAM = {
  stablePool: STABLE_POOL,
  pool: POOL,
  withdrawStable: 5_012_345n,
  payFeesStable: 12_345n,
  minNativeOut: 47_000_000_000n,
  minUnderlyingOut: 5_100_000n,
  remoteFeesCash: 300_000n,
  beneficiaryHex: BENEFICIARY_HEX,
  peopleParaId: PEOPLE_PARA,
  maxWeight: { ref_time: 5n, proof_size: 6n },
};

const instruction = (args: ExecuteArgs, type: string) =>
  args.message.value.find((i) => i.type === type)?.value as never;
const exchanges = (args: ExecuteArgs) =>
  args.message.value
    .filter((i) => i.type === "ExchangeAsset")
    .map(
      (i) =>
        i.value as {
          give: { type: string; value: unknown };
          want: Fungible[];
          maximal: boolean;
        },
    );

describe("buildStableFundingProgram", () => {
  const args = buildStableFundingProgram(PROGRAM) as unknown as ExecuteArgs;

  it("withdraws the stable, pays the fees in it, exchanges twice, teleports the CASH, refunds the surplus", () => {
    expect(args.message.value.map((i) => i.type)).toEqual([
      "WithdrawAsset",
      "PayFees",
      "ExchangeAsset",
      "ExchangeAsset",
      "InitiateTransfer",
      "RefundSurplus",
      "DepositAsset",
    ]);
    const withdrawn = instruction(args, "WithdrawAsset") as Fungible[];
    expect(withdrawn).toEqual([
      { id: TOKENS.USDC.location, fun: { type: "Fungible", value: PROGRAM.withdrawStable } },
    ]);
    const payFees = (instruction(args, "PayFees") as { asset: Fungible }).asset;
    expect(payFees).toEqual({
      id: TOKENS.USDC.location,
      fun: { type: "Fungible", value: PROGRAM.payFeesStable },
    });
    expect(args.max_weight).toEqual(PROGRAM.maxWeight);
  });

  it("gives the stable the fees leave for the native with its floor, then names the native for CASH with the requirement as the floor", () => {
    const [first, second] = exchanges(args);
    expect(first!.give).toEqual({
      type: "Definite",
      value: [
        {
          id: TOKENS.USDC.location,
          fun: { type: "Fungible", value: PROGRAM.withdrawStable - PROGRAM.payFeesStable },
        },
      ],
    });
    expect(first!.want).toEqual([
      { id: NATIVE_LOC, fun: { type: "Fungible", value: PROGRAM.minNativeOut } },
    ]);
    expect(first!.maximal).toBe(true);
    // The second exchange names the native.
    expect(second!.give).toEqual({
      type: "Wild",
      value: {
        type: "AllOf",
        value: { id: NATIVE_LOC, fun: { type: "Fungible", value: undefined } },
      },
    });
    expect(second!.want).toEqual([
      { id: TOKENS.CASH.location, fun: { type: "Fungible", value: PROGRAM.minUnderlyingOut } },
    ]);
    expect(second!.maximal).toBe(true);
  });

  it("teleports the holding to the burner on People with the earmark, and deposits the refund back on the burner", () => {
    const transfer = instruction(args, "InitiateTransfer") as {
      destination: unknown;
      remote_fees: { type: string; value: { type: string; value: Fungible[] } };
      preserve_origin: boolean;
      assets: Array<{ type: string; value: unknown }>;
      remote_xcm: Instruction[];
    };
    expect(transfer.destination).toEqual(peopleDest(PEOPLE_PARA));
    expect(transfer.remote_fees.value.value[0]!.fun.value).toBe(PROGRAM.remoteFeesCash);
    expect(transfer.remote_fees.value.value[0]!.id).toEqual(TOKENS.CASH.location);
    expect(transfer.preserve_origin).toBe(false);
    expect(transfer.assets).toEqual([
      { type: "Teleport", value: { type: "Wild", value: { type: "AllCounted", value: 1 } } },
    ]);
    expect(transfer.remote_xcm.map((i) => i.type)).toEqual(["RefundSurplus", "DepositAsset"]);
    const refund = instruction(args, "DepositAsset") as {
      assets: unknown;
      beneficiary: { interior: { value: { value: { id: string } } } };
    };
    expect(refund.assets).toEqual({ type: "Wild", value: { type: "AllCounted", value: 1 } });
    expect(refund.beneficiary.interior.value.value.id).toBe(BENEFICIARY_HEX);
  });
});

const toPeople = { type: "V5", value: peopleDest(PEOPLE_PARA) };

/** An Asset Hub api that records the fee reads and the calls the estimate makes. */
function recordingApi(
  opts: {
    dispatchNative?: bigint;
    localExternal?: bigint;
    deliveryExternal?: bigint;
    /** The stable's min_balance; undefined is an asset Asset Hub does not know. */
    minBalance?: bigint | undefined;
    /** The pool's stable price for the native dispatch fee; undefined is the runtime's "cannot". */
    dispatchExternal?: bigint | undefined;
    /** What a dry run of the program forwards to People, when the burner is given. */
    forwarded?: unknown;
  } = {},
) {
  const seen: {
    executed: ExecuteArgs[];
    weighed?: ExecuteArgs["message"];
    localFeeAsset?: unknown;
    delivery?: unknown[];
    feeFrom?: unknown;
    feeOptions?: unknown;
    quote?: unknown[];
    dryRun?: unknown[];
    assetRead?: unknown;
  } = { executed: [] };
  const api = {
    query: {
      Assets: {
        Asset: {
          getValue: async (id: unknown) => {
            seen.assetRead = id;
            const minBalance = "minBalance" in opts ? opts.minBalance : MIN_BALANCE;
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
            getEstimatedFees: async (from: unknown, options: unknown) => {
              seen.feeFrom = from;
              seen.feeOptions = options;
              return opts.dispatchNative ?? 1_000_000_000n;
            },
          };
        },
      },
    },
    apis: {
      XcmPaymentApi: {
        query_xcm_weight: async (message: ExecuteArgs["message"]) => {
          seen.weighed = message;
          return { success: true, value: { ref_time: 1_000_000n, proof_size: 1_000n } };
        },
        query_weight_to_asset_fee: async (_weight: unknown, asset: unknown) => {
          seen.localFeeAsset = asset;
          return { success: true, value: opts.localExternal ?? 4_000n };
        },
        query_delivery_fees: async (...args: unknown[]) => {
          seen.delivery = args;
          return {
            success: true,
            value: {
              value: [{ fun: { type: "Fungible", value: opts.deliveryExternal ?? 250n } }],
            },
          };
        },
      },
      AssetConversionApi: {
        quote_price_tokens_for_exact_tokens: async (...args: unknown[]) => {
          seen.quote = args;
          return "dispatchExternal" in opts ? opts.dispatchExternal : 70_000n;
        },
      },
      DryRunApi: {
        dry_run_call: async (...args: unknown[]) => {
          seen.dryRun = args;
          return {
            success: true,
            value: {
              execution_result: { success: true, value: {} },
              emitted_events: [],
              forwarded_xcms: opts.forwarded ? [[toPeople, [opts.forwarded]]] : [],
            },
          };
        },
      },
    },
  };
  return { api: api as never, seen };
}

describe("estimateStableProgramFees", () => {
  const input = {
    stable: "USDC" as const,
    stablePool: STABLE_POOL,
    pool: POOL,
    beneficiaryHex: BENEFICIARY_HEX,
    peopleParaId: PEOPLE_PARA,
    depositStable: 5_400_000n,
    minUnderlyingOut: 5_100_000n,
    remoteFeesCash: 300_000n,
    feeProbeAddress: "5Probe",
  };

  it("prices execution, delivery and the dispatch all in the stable, and holds back min_balance plus the cushioned allowance", async () => {
    const { api, seen } = recordingApi({
      dispatchNative: 1_234n,
      localExternal: 2_256n,
      deliveryExternal: 28_857n,
      dispatchExternal: 8_765n,
    });
    const fees = await estimateStableProgramFees({ api, ...input });
    expect(seen.assetRead).toBe(TOKENS.USDC.assetHubId);
    // The weighed shape is the program itself, carved from the deposit with a quarter of it as
    // the allowance and floors the exchanges cannot miss.
    expect(seen.weighed!.value.map((i) => i.type)).toEqual([
      "WithdrawAsset",
      "PayFees",
      "ExchangeAsset",
      "ExchangeAsset",
      "InitiateTransfer",
      "RefundSurplus",
      "DepositAsset",
    ]);
    const weighed = { message: seen.weighed!, max_weight: undefined };
    expect((instruction(weighed, "WithdrawAsset") as Fungible[])[0]!.fun.value).toBe(
      input.depositStable - MIN_BALANCE,
    );
    expect(exchanges(weighed)[0]!.want[0]!.fun.value).toBe(1n);
    expect(exchanges(weighed)[1]!.want[0]!.fun.value).toBe(1n);
    // Every fee read is keyed by the stable.
    expect(seen.localFeeAsset).toEqual({ type: "V5", value: TOKENS.USDC.location });
    expect(seen.delivery).toEqual([
      { type: "V5", value: peopleDest(PEOPLE_PARA) },
      forwardedProgramStandIn(
        TOKENS.CASH.locationOnPeople as never,
        input.minUnderlyingOut,
        BENEFICIARY_HEX,
      ),
      { type: "V5", value: TOKENS.USDC.location },
    ]);
    expect(seen.feeFrom).toBe("5Probe");
    expect(seen.feeOptions).toEqual({ asset: TOKENS.USDC.location });
    expect(seen.quote).toEqual([TOKENS.USDC.location, TOKENS.PAS.location, 1_234n, true]);
    // The dispatch probe carries the measured fees, the real CASH floor and the weighed weight.
    const dispatchProbe = seen.executed.at(-1)!;
    expect(exchanges(dispatchProbe)[1]!.want[0]!.fun.value).toBe(input.minUnderlyingOut);
    expect((instruction(dispatchProbe, "PayFees") as { asset: Fungible }).asset.fun.value).toBe(
      2_256n + 28_857n,
    );
    expect(dispatchProbe.max_weight).toEqual({ ref_time: 1_000_000n, proof_size: 1_000n });
    expect(fees).toEqual({
      localExternal: 2_256n,
      deliveryExternal: 28_857n,
      feeAllowanceExternal: withFeeMargin(2_256n + 28_857n),
      minBalanceExternal: MIN_BALANCE,
      heldBackExternal: MIN_BALANCE + withFeeMargin(2_256n + 28_857n),
      dispatchNative: 1_234n,
      dispatchExternal: 8_765n,
      maxWeight: { ref_time: 1_000_000n, proof_size: 1_000n },
    });
  });

  it("dry-runs the bare execute as the burner for the real forwarded program, with the weighed ceiling", async () => {
    const forwarded = { type: "V5", value: [{ type: "ReceiveTeleportedAsset", value: [] }] };
    const { api, seen } = recordingApi({ forwarded });
    await estimateStableProgramFees({ api, ...input, dryRunFrom: "5Burner" });
    expect(seen.dryRun![0]).toEqual({
      type: "system",
      value: { type: "Signed", value: "5Burner" },
    });
    const call = seen.dryRun![1] as { type: string; value: { type: string; value: ExecuteArgs } };
    expect(call.type).toBe("PolkadotXcm");
    expect(call.value.type).toBe("execute");
    // Both floors at one: a real deposit is a quarter short of the target in this probe, and a
    // floor the exchanges cannot reach would fail the dry run and lose the forwarded program.
    expect(exchanges(call.value.value)[0]!.want[0]!.fun.value).toBe(1n);
    expect(exchanges(call.value.value)[1]!.want[0]!.fun.value).toBe(1n);
    expect(call.value.value.max_weight).toEqual({ ref_time: 1_000_000n, proof_size: 1_000n });
    expect(seen.delivery![1]).toBe(forwarded);
    expect(seen.feeFrom).toBe("5Burner");
  });

  it("never hands the pool tier's fallback ceiling to a call it prices or dry-runs", async () => {
    const { api, seen } = recordingApi({ forwarded: { type: "V5", value: [] } });
    await estimateStableProgramFees({ api, ...input, dryRunFrom: "5Burner" });
    expect(seen.executed.length).toBeGreaterThan(0);
    for (const args of seen.executed) {
      expect(args.max_weight).not.toEqual(FUNDING_PROGRAM_MAX_WEIGHT);
      expect(args.max_weight).toEqual({ ref_time: 1_000_000n, proof_size: 1_000n });
    }
  });

  it("reads USDT under its own id when the stable is USDT", async () => {
    const { api, seen } = recordingApi();
    await estimateStableProgramFees({
      api,
      ...input,
      stable: "USDT",
      stablePool: { native: NATIVE_LOC, underlying: TOKENS.USDT.location } as unknown as Pool,
    });
    expect(seen.assetRead).toBe(TOKENS.USDT.assetHubId);
    expect(seen.feeOptions).toEqual({ asset: TOKENS.USDT.location });
  });

  it("refuses a deposit that does not cover what is held back, an asset Asset Hub does not know, and an unpriceable dispatch", async () => {
    await expect(
      estimateStableProgramFees({ api: recordingApi().api, ...input, depositStable: 90_000n }),
    ).rejects.toThrow(/does not cover/);
    await expect(
      estimateStableProgramFees({ api: recordingApi({ minBalance: undefined }).api, ...input }),
    ).rejects.toThrow(/not an asset/);
    await expect(
      estimateStableProgramFees({
        api: recordingApi({ dispatchExternal: undefined }).api,
        ...input,
      }),
    ).rejects.toThrow(/cannot price the dispatch fee/);
  });
});
