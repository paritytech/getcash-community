// The PSM batch over a recording Asset Hub api: the mint sizing against the pallet's rounding, the
// two calls' shapes and order, the fee estimate's asset on every read, the margin it carries and
// the min_balance it holds back, and the dry run refusing the batch for every reason the pool
// tier's dry run refuses the bare execute.

import { AccountId } from "polkadot-api";
import { TOKENS, type XcmLocation } from "@getsome/core";
import { describe, expect, it } from "vitest";
import {
  buildPsmFundingProgram,
  FEE_MARGIN_BPS,
  FUNDING_PROGRAM_MAX_WEIGHT,
  sortedAssets,
  withFeeMargin,
} from "./funding-program";
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

/** USDt's min_balance on Paseo Asset Hub Next, as the scripted chain answers it. */
const MIN_BALANCE = 70_000n;
const BATCH = {
  route: ROUTE,
  externalIn: 5_125_629n,
  cashMinted: 5_100_000n,
  feeAllowanceExternal: 12_345n,
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
    localExternal?: bigint;
    deliveryExternal?: bigint;
    /** The external's min_balance; undefined is an asset Asset Hub does not know. */
    minBalance?: bigint | undefined;
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
    assetRead?: unknown;
  } = {};
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

  it("withdraws the fee allowance in USDT and the minted CASH, pays the XCM's fees in USDT, teleports the CASH with the remote program, and refunds the surplus to the burner: no exchange", () => {
    const { api, seen } = recordingApi();
    buildPsmBatch(api, BATCH);
    const execute = seen.execute as ExecuteArgs;
    expect(execute.max_weight).toEqual(FUNDING_PROGRAM_MAX_WEIGHT);
    expect(execute.message.value.map((i) => i.type)).toEqual([
      "WithdrawAsset",
      "PayFees",
      "InitiateTransfer",
      "RefundSurplus",
      "DepositAsset",
    ]);
    const [withdraw, payFees, transfer, , refund] = execute.message.value;
    const usdt = { id: TOKENS.USDT.location, fun: { type: "Fungible", value: 12_345n } };
    // Both withdrawals in one instruction, USDT first: the runtime's Assets codec refuses an
    // unsorted list, and USDt's pallet-assets id is the lower.
    expect(withdraw!.value).toEqual([
      usdt,
      { id: TOKENS.CASH.location, fun: { type: "Fungible", value: BATCH.cashMinted } },
    ]);
    expect((payFees!.value as { asset: Fungible }).asset).toEqual(usdt);
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
    // The USDT sits in the fees register by now, so the holding is CASH alone and one counted
    // asset is the whole of it.
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
    // The local refund comes after the transfer, so delivery is still paid from the fees register,
    // and counts one asset: a Wild(All) is weighed as a deposit of every asset the holding can
    // carry.
    expect(refund!.value).toEqual({
      assets: { type: "Wild", value: { type: "AllCounted", value: 1 } },
      beneficiary: {
        parents: 0,
        interior: {
          type: "X1",
          value: { type: "AccountId32", value: { network: undefined, id: BENEFICIARY_HEX } },
        },
      },
    });
  });

  it("sorts the withdrawal as the runtime's Assets codec requires, whichever asset pays the fees", () => {
    const higher: XcmLocation = {
      parents: 0,
      interior: {
        type: "X2",
        value: [
          { type: "PalletInstance", value: 50 },
          { type: "GeneralIndex", value: 60_000_000n },
        ],
      },
    };
    const program = buildPsmFundingProgram({
      withdrawCash: 5n,
      localFees: { id: higher, amount: 7n },
      remoteFeesCash: 1n,
      beneficiaryHex: BENEFICIARY_HEX,
      peopleParaId: PEOPLE_PARA,
    }) as unknown as ExecuteArgs;
    expect((program.message.value[0]!.value as Fungible[]).map((a) => a.id)).toEqual([
      TOKENS.CASH.location,
      higher,
    ]);
    // Parents first, then arity, then each junction by variant and value.
    const ids: XcmLocation[] = [
      TOKENS.CASH.locationOnPeople,
      TOKENS.PAS.location,
      TOKENS.CASH.location,
      TOKENS.USDT.location,
      {
        parents: 1,
        interior: {
          type: "X2",
          value: [
            { type: "Parachain", value: 1500 },
            { type: "GeneralIndex", value: 1n },
          ],
        },
      },
    ];
    expect(sortedAssets(ids.map((id) => ({ id }))).map((a) => a.id)).toEqual([
      TOKENS.USDT.location,
      TOKENS.CASH.location,
      TOKENS.PAS.location,
      ids[4],
      TOKENS.CASH.locationOnPeople,
    ]);
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
    depositExternal: 5_300_000n,
    remoteFeesCash: BATCH.remoteFeesCash,
    feeProbeAddress: "5Probe",
  };
  const usdtV5 = { type: "V5", value: TOKENS.USDT.location };

  it("prices the XCM's execution and delivery and the batch's dispatch all in the external, holds back min_balance plus the margined allowance", async () => {
    const { api, seen } = recordingApi({
      dispatchNative: 900_000_000n,
      localExternal: 4_000n,
      deliveryExternal: 250n,
      dispatchExternal: 68_000n,
    });
    const fees = await estimatePsmBatchFees({ api, ...input });
    expect(fees).toEqual({
      localExternal: 4_000n,
      deliveryExternal: 250n,
      feeAllowanceExternal: 4_675n, // 4,250 and a tenth
      minBalanceExternal: MIN_BALANCE,
      heldBackExternal: MIN_BALANCE + 4_675n,
      dispatchNative: 900_000_000n,
      dispatchExternal: 68_000n,
      maxWeight: { ref_time: 1_000_000n, proof_size: 1_000n },
    });
    // The min_balance is the chain's, read under the external's pallet-assets id.
    expect(seen.assetRead).toBe(TOKENS.USDT.assetHubId);
    // The weighed message is the PSM shape, refund included.
    expect((seen.weighed as { value: Instruction[] }).value.map((i) => i.type)).toEqual([
      "WithdrawAsset",
      "PayFees",
      "InitiateTransfer",
      "RefundSurplus",
      "DepositAsset",
    ]);
    expect(seen.localFeeAsset).toEqual(usdtV5);
    // Delivery to People, priced in the external, from the stand-in with CASH as People keys it.
    const [dest, standIn, deliveryAsset] = seen.delivery!;
    expect(dest).toEqual({
      type: "V5",
      value: {
        parents: 1,
        interior: { type: "X1", value: { type: "Parachain", value: PEOPLE_PARA } },
      },
    });
    expect(deliveryAsset).toEqual(usdtV5);
    const travelling = (standIn as { value: Instruction[] }).value[0]!.value as Fungible[];
    expect(travelling[0]!.id).toEqual(TOKENS.CASH.locationOnPeople);
    // The dispatch is priced on the final batch, with the fee-asset option, then converted at the
    // pool's exact-out price with its fee included.
    expect(seen.feeFrom).toBe("5Probe");
    expect(seen.feeOptions).toEqual({ asset: TOKENS.USDT.location });
    const final = seen.execute as ExecuteArgs;
    expect((final.message.value[1]!.value as { asset: Fungible }).asset).toEqual({
      id: TOKENS.USDT.location,
      fun: { type: "Fungible", value: 4_675n },
    });
    expect(final.max_weight).toEqual(fees.maxWeight);
    // The probe's mint is the deposit less what is held back, so its encoding is the batch's.
    expect((seen.mint as { external_amount: bigint }).external_amount).toBe(
      input.depositExternal - fees.heldBackExternal,
    );
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

  it("carries the margin the live chain needs: the exact estimate came in short of the charge", async () => {
    // Measured on Paseo Asset Hub Next on 2026-09-23 for a 50 CASH top-up. In CASH: execution
    // quoted and charged 4,335, delivery quoted 76,204 and charged 76,665, so the exact allowance
    // of 80,539 failed InitiateTransfer with NotHoldingFees and 81,000 was the least that passed.
    // In USDT, the asset that pays now: execution 2,256 both ways, delivery quoted 28,857 and
    // charged 29,032.
    expect(FEE_MARGIN_BPS).toBe(1_000n);
    expect(withFeeMargin(80_539n)).toBe(88_593n);
    expect(withFeeMargin(80_539n)).toBeGreaterThanOrEqual(81_000n);
    const { api } = recordingApi({ localExternal: 2_256n, deliveryExternal: 28_857n });
    const fees = await estimatePsmBatchFees({ api, ...input });
    expect(fees.feeAllowanceExternal).toBe(34_225n);
    expect(fees.feeAllowanceExternal).toBeGreaterThanOrEqual(2_256n + 29_032n);
  });

  it("refuses a deposit that does not cover what is held back, and an external Asset Hub does not know", async () => {
    await expect(
      estimatePsmBatchFees({ api: recordingApi().api, ...input, depositExternal: 80_000n }),
    ).rejects.toThrow(/does not cover the .* held back for fees/);
    await expect(
      estimatePsmBatchFees({ api: recordingApi({ minBalance: undefined }).api, ...input }),
    ).rejects.toThrow(/USDT is not an asset on Asset Hub/);
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
            // The fees are paid in the USDT withdrawn beside it, so all the CASH travels.
            const withdrawnCash = (execute.message.value[0]!.value as Fungible[]).find(
              (a) => a.id === TOKENS.CASH.location,
            )!.fun.value;
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
                  value: [fungible(withdrawnCash - earmark)],
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
    // 5.1 CASH minted, 0.05 to People's fees, the XCM's own paid in USDT: 5.05 lands.
    await expect(run(chains)).resolves.toEqual({ landed: 5_050_000n });
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
    await expect(run(scriptedChains({}), 5_050_000n)).resolves.toEqual({ landed: 5_050_000n });
    await expect(run(scriptedChains({}), 5_050_001n)).rejects.toThrow(
      /not submitted: only 5050000 of 5050001 underlying would reach the beneficiary on People/,
    );
  });
});
