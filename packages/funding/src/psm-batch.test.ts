// The PSM batch over a recording Asset Hub api: the mint sizing against the pallet's rounding, the
// two calls' shapes and order, the fee estimate's asset on every read, and the dry run refusing
// the batch for every reason the pool tier's dry run refuses the bare execute.

import { AccountId } from "polkadot-api";
import { TOKENS } from "@getsome/core";
import { describe, expect, it } from "vitest";
import { FUNDING_PROGRAM_MAX_WEIGHT } from "./funding-program";
import {
  buildPsmBatch,
  dryRunPsmBatch,
  estimatePsmBatchFees,
  PERMILL,
  permillMulCeil,
  psmBatchTxOptions,
  psmMintOut,
  sizePsmMint,
  type PsmRoute,
} from "./psm-batch";

type Instruction = { type: string; value: unknown };
type Fungible = { id: unknown; fun: { type: string; value: bigint } };
type Call = { type: string; value: { type: string; value: unknown } };
type ExecuteArgs = { message: { value: Instruction[] }; max_weight: unknown };

const CASH = 1_000_000n; // one CASH, 6 decimals
const ROUTE: PsmRoute = { tier: "psm", external: "USDT", feeRate: 5_000 };
const PEOPLE_PARA = 1502;
const ASSET_HUB_PARA = 1500;
const BENEFICIARY_HEX = `0x${"07".repeat(32)}`;
const BENEFICIARY_SS58 = AccountId(42).dec(new Uint8Array(32).fill(7));
const FEE_RECEIVER_SS58 = AccountId(42).dec(new Uint8Array(32).fill(9));

const BATCH = {
  route: ROUTE,
  externalIn: 5_125_629n,
  cashMinted: 5_100_000n,
  payFeesCash: 12_345n,
  remoteFeesCash: 300_000n,
  beneficiaryHex: BENEFICIARY_HEX,
  peopleParaId: PEOPLE_PARA,
};

describe("the PSM's rounding", () => {
  it("mirrors Permill::mul_ceil: the product rounded up, zero at zero, whole at one", () => {
    expect(permillMulCeil(1_000n, 5_000)).toBe(5n);
    expect(permillMulCeil(1_001n, 5_000)).toBe(6n); // 5.005 rounds up
    expect(permillMulCeil(199n, 5_000)).toBe(1n); // 0.995 rounds up
    expect(permillMulCeil(0n, 5_000)).toBe(0n);
    expect(permillMulCeil(123_456n, 0)).toBe(0n);
    expect(permillMulCeil(123_456n, Number(PERMILL))).toBe(123_456n);
    expect(psmMintOut(1_000n, 5_000)).toBe(995n);
    expect(psmMintOut(1_001n, 5_000)).toBe(995n);
  });
});

describe("sizePsmMint", () => {
  const feeRates = [0, 1, 5_000, 10_000, 333_333, 500_000, 999_999];
  const targets = [
    ...Array.from({ length: 1_200 }, (_, i) => BigInt(i + 1)),
    999_999n,
    CASH,
    5_100_000n,
    123_456_789n,
    100_000_000n * CASH,
  ];

  it("finds the smallest mint that lands the target, at every rate, through the rounding", () => {
    for (const feeRate of feeRates) {
      const route = { ...ROUTE, feeRate };
      for (const target of targets) {
        const { externalIn, cashMinted } = sizePsmMint(target, route);
        // The pallet's payout for this mint reaches the target...
        expect(psmMintOut(externalIn, feeRate)).toBe(cashMinted);
        expect(cashMinted).toBeGreaterThanOrEqual(target);
        // ...and one unit less does not.
        expect(psmMintOut(externalIn - 1n, feeRate)).toBeLessThan(target);
        // With equal decimals the payout steps by at most one per unit in, so the smallest mint
        // that reaches the target lands it exactly.
        expect(cashMinted).toBe(target);
      }
    }
  });

  it("is not the fee on the target added to it: that lands a unit short where the ceiling bites", () => {
    // 200 CASH-units at 0.5%: the fee on 200 is 1, but the fee on 201 is ceil(1.005) = 2.
    const naive = 200n + permillMulCeil(200n, 5_000);
    expect(psmMintOut(naive, 5_000)).toBe(199n);
    expect(sizePsmMint(200n, ROUTE)).toEqual({ externalIn: 202n, cashMinted: 200n });
    // Where the ceiling does not bite the two agree.
    expect(sizePsmMint(199n, ROUTE)).toEqual({ externalIn: 200n, cashMinted: 199n });
  });

  it("carries no headroom: 5.1 CASH at 0.5% is 5.125629 USDT, not a percent more", () => {
    expect(sizePsmMint(5_100_000n, ROUTE)).toEqual({
      externalIn: 5_125_629n,
      cashMinted: 5_100_000n,
    });
    expect(sizePsmMint(0n, ROUTE)).toEqual({ externalIn: 0n, cashMinted: 0n });
  });

  it("refuses a rate that keeps nothing", () => {
    expect(() => sizePsmMint(CASH, { ...ROUTE, feeRate: Number(PERMILL) })).toThrow(
      /keeps nothing/,
    );
  });
});

/** An Asset Hub api that records the three calls' arguments and answers the fee reads. */
function recordingApi(
  opts: {
    dispatchNative?: bigint;
    localCash?: bigint;
    deliveryCash?: bigint;
    /** The pool's USDT price for the native dispatch fee; undefined is the runtime's "cannot". */
    dispatchExternal?: bigint | undefined;
    /** What a dry run of the batch forwards to People, when the burner is given. */
    forwarded?: unknown;
  } = {},
) {
  const seen: {
    mint?: unknown;
    execute?: unknown;
    batch?: unknown;
    weighed?: unknown;
    localFeeAsset?: unknown;
    delivery?: unknown[];
    feeFrom?: unknown;
    feeOptions?: unknown;
    quote?: unknown[];
    dryRun?: unknown[];
  } = {};
  const api = {
    tx: {
      Psm: {
        mint: (args: unknown) => {
          seen.mint = args;
          return { decodedCall: { type: "Psm", value: { type: "mint", value: args } } };
        },
      },
      PolkadotXcm: {
        execute: (args: unknown) => {
          seen.execute = args;
          return { decodedCall: { type: "PolkadotXcm", value: { type: "execute", value: args } } };
        },
      },
      Utility: {
        batch_all: (args: unknown) => {
          seen.batch = args;
          return {
            decodedCall: { type: "Utility", value: { type: "batch_all", value: args } },
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
        query_xcm_weight: async (message: unknown) => {
          seen.weighed = message;
          return { success: true, value: { ref_time: 1_000_000n, proof_size: 1_000n } };
        },
        query_weight_to_asset_fee: async (_weight: unknown, asset: unknown) => {
          seen.localFeeAsset = asset;
          return { success: true, value: opts.localCash ?? 4_000n };
        },
        query_delivery_fees: async (...args: unknown[]) => {
          seen.delivery = args;
          return {
            success: true,
            value: { value: [{ fun: { type: "Fungible", value: opts.deliveryCash ?? 250n } }] },
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
              forwarded_xcms: opts.forwarded
                ? [
                    [
                      {
                        type: "V5",
                        value: {
                          parents: 1,
                          interior: {
                            type: "X1",
                            value: { type: "Parachain", value: PEOPLE_PARA },
                          },
                        },
                      },
                      [opts.forwarded],
                    ],
                  ]
                : [],
            },
          };
        },
      },
    },
  };
  return { api: api as never, seen };
}

describe("buildPsmBatch", () => {
  it("is batch_all of the mint then the execute, and nothing else", () => {
    const { api, seen } = recordingApi();
    const { batch, execArgs } = buildPsmBatch(api, BATCH);
    const calls = (seen.batch as { calls: Call[] }).calls;
    expect(calls.map((c) => `${c.type}.${c.value.type}`)).toEqual([
      "Psm.mint",
      "PolkadotXcm.execute",
    ]);
    expect(calls[0]!.value.value).toBe(seen.mint);
    expect(calls[1]!.value.value).toBe(execArgs);
    expect((batch as { decodedCall: Call }).decodedCall.value.value).toBe(seen.batch);
  });

  it("mints against the table's Locations, the external amount, and the route's fee verbatim as max_fee", () => {
    const { api, seen } = recordingApi();
    buildPsmBatch(api, { ...BATCH, route: { ...ROUTE, feeRate: 7_500 } });
    expect(seen.mint).toEqual({
      internal_asset: TOKENS.CASH.location,
      external_asset: TOKENS.USDT.location,
      external_amount: BATCH.externalIn,
      max_fee: 7_500,
    });
  });

  it("withdraws the minted CASH, pays the XCM's fees in CASH, and teleports the rest with the remote program: no exchange", () => {
    const { api, seen } = recordingApi();
    buildPsmBatch(api, BATCH);
    const execute = seen.execute as ExecuteArgs;
    expect(execute.max_weight).toEqual(FUNDING_PROGRAM_MAX_WEIGHT);
    expect(execute.message.value.map((i) => i.type)).toEqual([
      "WithdrawAsset",
      "PayFees",
      "InitiateTransfer",
    ]);
    const [withdraw, payFees, transfer] = execute.message.value;
    expect(withdraw!.value).toEqual([
      { id: TOKENS.CASH.location, fun: { type: "Fungible", value: BATCH.cashMinted } },
    ]);
    expect((payFees!.value as { asset: Fungible }).asset).toEqual({
      id: TOKENS.CASH.location,
      fun: { type: "Fungible", value: BATCH.payFeesCash },
    });
    const t = transfer!.value as {
      destination: { parents: number; interior: { value: { type: string; value: number } } };
      remote_fees: { type: string; value: { type: string; value: Fungible[] } };
      preserve_origin: boolean;
      assets: Array<{ type: string; value: { value: { type: string; value: number } } }>;
      remote_xcm: Instruction[];
    };
    expect(t.destination).toEqual({
      parents: 1,
      interior: { type: "X1", value: { type: "Parachain", value: PEOPLE_PARA } },
    });
    expect(t.remote_fees.type).toBe("Teleport");
    expect(t.remote_fees.value.type).toBe("Definite");
    expect(t.remote_fees.value.value).toEqual([
      { id: TOKENS.CASH.location, fun: { type: "Fungible", value: BATCH.remoteFeesCash } },
    ]);
    expect(t.preserve_origin).toBe(false);
    expect(t.assets).toEqual([
      { type: "Teleport", value: { type: "Wild", value: { type: "AllCounted", value: 1 } } },
    ]);
    expect(t.remote_xcm.map((i) => i.type)).toEqual(["RefundSurplus", "DepositAsset"]);
    const deposit = t.remote_xcm[1]!.value as {
      assets: { type: string };
      beneficiary: { parents: number; interior: { value: { value: { id: string } } } };
    };
    expect(deposit.assets.type).toBe("Wild");
    expect(deposit.beneficiary.parents).toBe(0);
    expect(deposit.beneficiary.interior.value.value.id).toBe(BENEFICIARY_HEX);
  });

  it("declares the weight ceiling it is given", () => {
    const { api, seen } = recordingApi();
    const maxWeight = { ref_time: 2_358_560_232n, proof_size: 61_000n };
    buildPsmBatch(api, { ...BATCH, maxWeight });
    expect((seen.execute as ExecuteArgs).max_weight).toEqual(maxWeight);
  });

  it("signs with the dispatch fee charged in the external", () => {
    expect(psmBatchTxOptions("USDT")).toEqual({ asset: TOKENS.USDT.location });
  });
});

describe("estimatePsmBatchFees", () => {
  const input = {
    route: ROUTE,
    beneficiaryHex: BENEFICIARY_HEX,
    peopleParaId: PEOPLE_PARA,
    externalIn: BATCH.externalIn,
    cashMinted: BATCH.cashMinted,
    remoteFeesCash: BATCH.remoteFeesCash,
    feeProbeAddress: "5Probe",
  };
  const cashV5 = { type: "V5", value: TOKENS.CASH.location };

  it("prices the XCM's execution and delivery in CASH and the batch's dispatch in the external", async () => {
    const { api, seen } = recordingApi({
      dispatchNative: 900_000_000n,
      localCash: 4_000n,
      deliveryCash: 250n,
      dispatchExternal: 68_000n,
    });
    const fees = await estimatePsmBatchFees({ api, ...input });
    expect(fees).toEqual({
      localCash: 4_000n,
      deliveryCash: 250n,
      payFeesCash: 4_250n,
      dispatchNative: 900_000_000n,
      dispatchExternal: 68_000n,
      maxWeight: { ref_time: 1_000_000n, proof_size: 1_000n },
    });
    // The weighed message is the PSM shape.
    expect((seen.weighed as { value: Instruction[] }).value.map((i) => i.type)).toEqual([
      "WithdrawAsset",
      "PayFees",
      "InitiateTransfer",
    ]);
    expect(seen.localFeeAsset).toEqual(cashV5);
    // Delivery to People, priced in CASH, from the stand-in with CASH as People keys it.
    const [dest, standIn, deliveryAsset] = seen.delivery!;
    expect(dest).toEqual({
      type: "V5",
      value: {
        parents: 1,
        interior: { type: "X1", value: { type: "Parachain", value: PEOPLE_PARA } },
      },
    });
    expect(deliveryAsset).toEqual(cashV5);
    const travelling = (standIn as { value: Instruction[] }).value[0]!.value as Fungible[];
    expect(travelling[0]!.id).toEqual(TOKENS.CASH.locationOnPeople);
    // The dispatch is priced on the final batch, with the fee-asset option, then converted at the
    // pool's exact-out price with its fee included.
    expect(seen.feeFrom).toBe("5Probe");
    expect(seen.feeOptions).toEqual({ asset: TOKENS.USDT.location });
    const final = seen.execute as ExecuteArgs;
    expect((final.message.value[1]!.value as { asset: Fungible }).asset.fun.value).toBe(4_250n);
    expect(final.max_weight).toEqual(fees.maxWeight);
    expect((seen.mint as { external_amount: bigint }).external_amount).toBe(BATCH.externalIn);
    expect(seen.quote).toEqual([TOKENS.USDT.location, TOKENS.PAS.location, 900_000_000n, true]);
    // No burner given: no dry run.
    expect(seen.dryRun).toBeUndefined();
  });

  it("dry-runs the batch as the burner for the real forwarded program, not the bare execute", async () => {
    const forwarded = { type: "V5", value: [{ type: "ReceiveTeleportedAsset", value: [] }] };
    const { api, seen } = recordingApi({ forwarded });
    await estimatePsmBatchFees({ api, ...input, dryRunFrom: "5Burner" });
    const [origin, call] = seen.dryRun!;
    expect(origin).toEqual({ type: "system", value: { type: "Signed", value: "5Burner" } });
    expect((call as Call).type).toBe("Utility");
    expect(seen.delivery![1]).toBe(forwarded);
    expect(seen.feeFrom).toBe("5Burner");
  });

  it("refuses a mint whose payout does not cover the program's own fees", async () => {
    const { api } = recordingApi({ localCash: BATCH.cashMinted });
    await expect(estimatePsmBatchFees({ api, ...input })).rejects.toThrow(
      /does not cover the program's own fees/,
    );
  });

  it("refuses when the pool cannot price the dispatch fee in the external", async () => {
    const { api } = recordingApi({ dispatchExternal: undefined });
    await expect(estimatePsmBatchFees({ api, ...input })).rejects.toThrow(
      /cannot price the dispatch fee/,
    );
  });
});

describe("dryRunPsmBatch", () => {
  const toPeople = {
    type: "V5",
    value: {
      parents: 1,
      interior: { type: "X1", value: { type: "Parachain", value: PEOPLE_PARA } },
    },
  };
  const fungible = (value: bigint) => ({
    id: TOKENS.CASH.locationOnPeople,
    fun: { type: "Fungible", value },
  });
  const trapped = (amount: bigint) => ({
    type: "PolkadotXcm",
    value: {
      type: "AssetsTrapped",
      value: { assets: { type: "V5", value: [{ fun: { type: "Fungible", value: amount } }] } },
    },
  });
  const deposited = (who: string, amount: bigint) => ({
    type: "Assets",
    value: { type: "Deposited", value: { who, amount } },
  });

  /** Asset Hub as the batch's dry run sees it, and People as the forwarded program's. */
  function scriptedChains(opts: {
    /** Asset Hub rejects the batch with this dispatch error. */
    rejectWith?: unknown;
    trapOnAssetHub?: bigint;
    forwardNothing?: boolean;
    peopleError?: string;
    trapOnPeople?: bigint;
    /** What People's execution takes from the arrival. */
    remoteFee?: bigint;
  }) {
    const seen: { call?: Call; origin?: unknown; peopleOrigin?: unknown; program?: unknown } = {};
    const { api: recording } = recordingApi();
    const api = {
      ...(recording as object),
      apis: {
        DryRunApi: {
          dry_run_call: async (origin: unknown, call: Call) => {
            seen.origin = origin;
            seen.call = call;
            if (opts.rejectWith) {
              return {
                success: true,
                value: {
                  execution_result: { success: false, value: { error: opts.rejectWith } },
                  emitted_events: [],
                  forwarded_xcms: [],
                },
              };
            }
            const execute = (call.value.value as { calls: Call[] }).calls[1]!.value
              .value as ExecuteArgs;
            const withdrawn = (execute.message.value[0]!.value as Fungible[])[0]!.fun.value;
            const payFees = (execute.message.value[1]!.value as { asset: Fungible }).asset.fun
              .value;
            const transfer = execute.message.value[2]!.value as {
              remote_fees: { value: { value: Fungible[] } };
              remote_xcm: Instruction[];
            };
            const earmark = transfer.remote_fees.value.value[0]!.fun.value;
            const forwarded = {
              type: "V5",
              value: [
                { type: "ReceiveTeleportedAsset", value: [fungible(earmark)] },
                { type: "PayFees", value: { asset: fungible(earmark) } },
                {
                  type: "ReceiveTeleportedAsset",
                  value: [fungible(withdrawn - payFees - earmark)],
                },
                { type: "ClearOrigin" },
                ...transfer.remote_xcm,
                { type: "SetTopic", value: `0x${"00".repeat(32)}` },
              ],
            };
            return {
              success: true,
              value: {
                execution_result: { success: true, value: {} },
                emitted_events: opts.trapOnAssetHub ? [trapped(opts.trapOnAssetHub)] : [],
                forwarded_xcms: opts.forwardNothing ? [] : [[toPeople, [forwarded]]],
              },
            };
          },
        },
      },
    };
    const peopleApi = {
      apis: {
        DryRunApi: {
          dry_run_xcm: async (origin: unknown, program: { value: Instruction[] }) => {
            seen.peopleOrigin = origin;
            seen.program = program;
            if (opts.peopleError) {
              return {
                success: true,
                value: {
                  execution_result: {
                    type: "Incomplete",
                    value: { used: {}, error: { type: opts.peopleError } },
                  },
                  emitted_events: [],
                },
              };
            }
            const teleported = program.value
              .filter((i) => i.type === "ReceiveTeleportedAsset")
              .reduce((sum, i) => sum + (i.value as Fungible[])[0]!.fun.value, 0n);
            const fee = opts.remoteFee ?? 50_000n;
            return {
              success: true,
              value: {
                execution_result: { type: "Complete", value: { used: {} } },
                emitted_events: [
                  deposited(BENEFICIARY_SS58, teleported - fee),
                  deposited(FEE_RECEIVER_SS58, fee),
                  ...(opts.trapOnPeople ? [trapped(opts.trapOnPeople)] : []),
                ],
              },
            };
          },
        },
      },
    };
    return { api: api as never, peopleApi: peopleApi as never, seen };
  }

  const run = (chains: ReturnType<typeof scriptedChains>, mustLand = 5_000_000n) =>
    dryRunPsmBatch({
      api: chains.api,
      peopleApi: chains.peopleApi,
      batch: buildPsmBatch(chains.api, BATCH),
      from: "5Burner",
      beneficiaryHex: BENEFICIARY_HEX,
      peopleParaId: PEOPLE_PARA,
      assetHubParaId: ASSET_HUB_PARA,
      mustLand,
    });

  it("runs the whole batch as the burner on Asset Hub and hands People what it forwards", async () => {
    const chains = scriptedChains({});
    // 5.1 CASH minted, 0.012345 to the XCM's fees, 0.05 to People's: 5.037655 lands.
    await expect(run(chains)).resolves.toEqual({ landed: 5_037_655n });
    expect(chains.seen.origin).toEqual({
      type: "system",
      value: { type: "Signed", value: "5Burner" },
    });
    const calls = (chains.seen.call!.value.value as { calls: Call[] }).calls;
    expect(chains.seen.call!.type).toBe("Utility");
    expect(calls.map((c) => `${c.type}.${c.value.type}`)).toEqual([
      "Psm.mint",
      "PolkadotXcm.execute",
    ]);
    expect(chains.seen.peopleOrigin).toEqual({
      type: "V5",
      value: {
        parents: 1,
        interior: { type: "X1", value: { type: "Parachain", value: ASSET_HUB_PARA } },
      },
    });
    expect((chains.seen.program as { value: Instruction[] }).value[0]!.type).toBe(
      "ReceiveTeleportedAsset",
    );
  });

  it("refuses a batch Asset Hub rejects, whether the PSM refuses the mint or the program fails", async () => {
    await expect(
      run(
        scriptedChains({
          rejectWith: {
            type: "Module",
            value: { type: "Psm", value: { type: "ExceedsMaxPsmDebt" } },
          },
        }),
      ),
    ).rejects.toThrow(/not submitted: Asset Hub rejects the program: Psm.ExceedsMaxPsmDebt/);
    await expect(
      run(
        scriptedChains({
          rejectWith: {
            type: "Module",
            value: {
              type: "PolkadotXcm",
              value: {
                type: "LocalExecutionIncompleteWithError",
                value: { index: 2, error: { type: "FeesNotMet" } },
              },
            },
          },
        }),
      ),
    ).rejects.toThrow(
      /not submitted: Asset Hub rejects the program: InitiateTransfer failed with FeesNotMet/,
    );
  });

  it("refuses a batch that would trap assets on either chain", async () => {
    await expect(run(scriptedChains({ trapOnAssetHub: 7n }))).rejects.toThrow(
      /not submitted: the program would trap 7 on Asset Hub/,
    );
    await expect(run(scriptedChains({ trapOnPeople: 9n }))).rejects.toThrow(
      /not submitted: the program would trap 9 on People/,
    );
  });

  it("refuses a batch that forwards nothing or that People would fail", async () => {
    await expect(run(scriptedChains({ forwardNothing: true }))).rejects.toThrow(
      /not submitted: Asset Hub forwards nothing to People/,
    );
    await expect(run(scriptedChains({ peopleError: "TooExpensive" }))).rejects.toThrow(
      /not submitted: the forwarded program fails on People with TooExpensive/,
    );
  });

  it("refuses a batch that would land short of what People needs, and not one unit sooner", async () => {
    await expect(run(scriptedChains({}), 5_037_655n)).resolves.toEqual({ landed: 5_037_655n });
    await expect(run(scriptedChains({}), 5_037_656n)).rejects.toThrow(
      /not submitted: only 5037655 of 5037656 underlying would reach the beneficiary on People/,
    );
  });
});
