import { describe, expect, it } from "vitest";
import { paseo_people_next } from "@polkadot-api/descriptors";
import { getOfflineApi, getTypedCodecs } from "polkadot-api";
import {
  FIXED_POINT_SCALE,
  LOCAL_XCM_MAX_WEIGHT,
  PASEO_ASSET_HUB_PARA_ID,
  PUSD_ASSET_ID,
} from "./constants";
import { withdrawalAccountFromPublicKey } from "./account";
import { createDrainXcmArgs, NATIVE_LOCATION, PUSD_LOCATION } from "./locations";
import {
  createSwapAndTransferBatch,
  prepareWithdrawalTransaction,
  type AssetHubApi,
  type PeopleApi,
} from "./papi";

const PUBLIC_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const BATCH_PUBLIC_KEY = new Uint8Array(32).fill(0x11);
const BATCH_PUBLIC_KEY_HEX =
  `0x${Array.from(BATCH_PUBLIC_KEY, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as const;
const LITERAL_NATIVE_LOCATION = {
  parents: 1,
  interior: { type: "Here", value: undefined },
};
const LITERAL_PUSD_LOCATION = {
  parents: 1,
  interior: {
    type: "X3",
    value: [
      { type: "Parachain", value: 1500 },
      { type: "PalletInstance", value: 50 },
      { type: "GeneralIndex", value: 50_000_413n },
    ],
  },
};

type DecodedCall = { type: string; value: { type: string; value: unknown } };
type DecodedBatch = {
  encodedData: Uint8Array;
  decodedCall: {
    type: "Utility";
    value: { type: "batch_all"; value: { calls: [DecodedCall, DecodedCall] } };
  };
};

type FakeTx = {
  decodedCall: unknown;
  getEncodedData: () => Promise<Uint8Array>;
  getPaymentInfo: (from: string, options: unknown) => Promise<{ partial_fee: bigint }>;
};

interface FakePeopleOptions {
  peopleBalance?: bigint;
  poolPUsd?: bigint;
  poolPas?: bigint;
  rate?: bigint | undefined;
  deliveryFactor?: bigint;
  peopleNativeMinimum?: bigint;
  sizingEncodedLength?: number;
  partialFees?: bigint[];
}

function fakePeopleApi(options: FakePeopleOptions = {}) {
  const state = {
    peopleBalance: options.peopleBalance ?? 2_000_000_000_000n,
    poolPUsd: options.poolPUsd ?? 8_000_000_000_000_000n,
    poolPas: options.poolPas ?? 40_000_000_000_000n,
    rate: "rate" in options ? options.rate : 2n * FIXED_POINT_SCALE,
    deliveryFactor: options.deliveryFactor ?? 2n * FIXED_POINT_SCALE,
    peopleNativeMinimum: options.peopleNativeMinimum ?? 100_000_000n,
    sizingEncodedLength: options.sizingEncodedLength ?? 180,
    partialFees: [...(options.partialFees ?? [15n, 21n])],
  };
  const reads: unknown[] = [];
  const deliveryFactorParas: number[] = [];
  const swaps: unknown[] = [];
  const xcms: unknown[] = [];
  const batches: Array<{ calls: unknown[]; tx: FakeTx }> = [];
  const paymentInfoCalls: Array<{ from: string; options: unknown }> = [];

  const makeTx = (decodedCall: unknown, encodedLength = 16): FakeTx => ({
    decodedCall,
    getEncodedData: async () => new Uint8Array(encodedLength),
    getPaymentInfo: async (from, txOptions) => {
      paymentInfoCalls.push({ from, options: txOptions });
      return { partial_fee: state.partialFees.shift() ?? 0n };
    },
  });

  const api = {
    constants: {
      Balances: { ExistentialDeposit: async () => state.peopleNativeMinimum },
    },
    query: {
      System: {
        Account: {
          getValue: async (address: string) => {
            reads.push(["System.Account", address]);
            return { data: { free: state.poolPas } };
          },
        },
      },
      Assets: {
        Account: {
          getValue: async (asset: unknown, address: string, readOptions?: unknown) => {
            reads.push(["Assets.Account", asset, address, readOptions]);
            if (address === "5Di1GihZ1G2dYzfD7gv2DLEzFvRMBLas3jXGLeicVCFFtr8B") {
              return state.poolPUsd === 0n ? undefined : { balance: state.poolPUsd };
            }
            return state.peopleBalance === 0n ? undefined : { balance: state.peopleBalance };
          },
        },
      },
      AssetRate: {
        ConversionRateToNative: {
          getValue: async (asset: unknown) => {
            reads.push(["AssetRate", asset]);
            return state.rate;
          },
        },
      },
      XcmpQueue: {
        DeliveryFeeFactor: {
          getValue: async (paraId: number) => {
            deliveryFactorParas.push(paraId);
            return state.deliveryFactor;
          },
        },
      },
    },
    tx: {
      AssetConversion: {
        swap_tokens_for_exact_tokens: (args: unknown) => {
          swaps.push(args);
          return makeTx({
            type: "AssetConversion",
            value: { type: "swap_tokens_for_exact_tokens", value: args },
          });
        },
      },
      PolkadotXcm: {
        execute: (args: unknown) => {
          xcms.push(args);
          return makeTx(
            { type: "PolkadotXcm", value: { type: "execute", value: args } },
            state.sizingEncodedLength,
          );
        },
      },
      Utility: {
        batch_all: (args: { calls: unknown[] }) => {
          const tx = makeTx({ type: "Utility", value: { type: "batch_all", value: args } });
          batches.push({ calls: args.calls, tx });
          return tx;
        },
      },
    },
  } as unknown as PeopleApi;

  return { api, state, reads, deliveryFactorParas, swaps, xcms, batches, paymentInfoCalls };
}

function fakeAssetHubApi(options: { balance?: bigint; nativeMinimum?: bigint } = {}) {
  const reads: unknown[] = [];
  const api = {
    constants: {
      Balances: { ExistentialDeposit: async () => options.nativeMinimum ?? 200_000_000n },
    },
    query: {
      Assets: {
        Account: {
          getValue: async (assetId: number, address: string, readOptions?: unknown) => {
            reads.push([assetId, address, readOptions]);
            return { balance: options.balance ?? 99n };
          },
        },
      },
    },
  } as unknown as AssetHubApi;
  return { api, reads };
}

describe("withdrawal PAPI batch construction", () => {
  it("encodes and decodes the production swap + XCM batch shape offline", async () => {
    const offline = await getOfflineApi(paseo_people_next);
    const codecs = await getTypedCodecs(paseo_people_next);
    const account = withdrawalAccountFromPublicKey(BATCH_PUBLIC_KEY);
    const batch = createSwapAndTransferBatch(offline as unknown as PeopleApi, {
      account,
      pasToSwap: 633_520_000n,
      pasForRemoteExecution: 46_000_000n,
      maxPUsdSwapInput: 63_543n,
      transferAmount: 930_284n,
    }) as unknown as DecodedBatch;
    const batchArgs = batch.decodedCall.value.value;
    const [swap, transfer] = batchArgs.calls;
    const transferValue = transfer.value.value as ReturnType<typeof createDrainXcmArgs> & {
      max_weight: typeof LOCAL_XCM_MAX_WEIGHT;
    };
    const message = transferValue.message;
    const [withdraw, teleport] = message.value;

    expect(batch.encodedData).toHaveLength(183);
    expect(codecs.tx.Utility.batch_all.dec(codecs.tx.Utility.batch_all.enc(batchArgs))).toEqual(
      batchArgs,
    );
    expect(batchArgs.calls.map((call) => `${call.type}.${call.value.type}`)).toEqual([
      "AssetConversion.swap_tokens_for_exact_tokens",
      "PolkadotXcm.execute",
    ]);
    expect(swap).toEqual({
      type: "AssetConversion",
      value: {
        type: "swap_tokens_for_exact_tokens",
        value: {
          path: [LITERAL_PUSD_LOCATION, LITERAL_NATIVE_LOCATION],
          amount_out: 633_520_000n,
          amount_in_max: 63_543n,
          send_to: account.address,
          keep_alive: true,
        },
      },
    });
    expect(transferValue.max_weight).toEqual(LOCAL_XCM_MAX_WEIGHT);
    expect(message.type).toBe("V5");
    expect(withdraw).toEqual({
      type: "WithdrawAsset",
      value: [
        { id: LITERAL_NATIVE_LOCATION, fun: { type: "Fungible", value: 633_520_000n } },
        { id: LITERAL_PUSD_LOCATION, fun: { type: "Fungible", value: 930_284n } },
      ],
    });
    expect(teleport).toMatchObject({
      type: "InitiateTeleport",
      value: {
        assets: { type: "Wild", value: { type: "AllCounted", value: 2 } },
        dest: {
          parents: 1,
          interior: { type: "X1", value: { type: "Parachain", value: 1500 } },
        },
        xcm: [
          {
            type: "BuyExecution",
            value: {
              fees: {
                id: LITERAL_NATIVE_LOCATION,
                fun: { type: "Fungible", value: 46_000_000n },
              },
              weight_limit: { type: "Unlimited", value: undefined },
            },
          },
          {
            type: "DepositAsset",
            value: {
              assets: { type: "Wild", value: { type: "AllCounted", value: 2 } },
              beneficiary: {
                parents: 0,
                interior: {
                  type: "X1",
                  value: {
                    type: "AccountId32",
                    value: { network: undefined, id: BATCH_PUBLIC_KEY_HEX },
                  },
                },
              },
            },
          },
        ],
      },
    });
  });

  it("prepares the exact-quote batch after two payment-info passes", async () => {
    const people = fakePeopleApi();
    const assetHub = fakeAssetHubApi({ nativeMinimum: 200_000_000n });
    const prepared = await prepareWithdrawalTransaction({
      peopleApi: people.api,
      assetHubApi: assetHub.api,
      publicKey: PUBLIC_KEY,
    });

    expect(prepared.amounts).toMatchObject({
      peopleBalance: people.state.peopleBalance,
      assetHubBalanceBefore: 99n,
      maxPUsdSwapInput: 203_527_729_981n,
      pasToSwap: 1_014_560_000n,
      pasForRemoteExecution: 236_000_000n,
      remoteExecutionFee: 36_000_000n,
      deliveryFee: 648_800_000n,
      deliveryFeeWithMargin: 778_560_000n,
      pUsdTransfer: 1_796_472_270_008n,
      encodedSizingXcmBytes: people.state.sizingEncodedLength,
    });
    expect(prepared.paymentInfoPasses).toEqual([
      {
        partialFeeNative: 15n,
        feePUsd: 8n,
        transferAmount: 1_796_472_270_011n,
      },
      {
        partialFeeNative: 21n,
        feePUsd: 11n,
        transferAmount: 1_796_472_270_008n,
      },
    ]);
    expect(people.batches).toHaveLength(3);
    expect(prepared.transaction).toBe(people.batches[2]?.tx);
    expect(prepared.options).toEqual({
      asset: LITERAL_PUSD_LOCATION,
      customSignedExtensions: {
        VerifyMultiSignature: { value: { type: "Disabled", value: undefined } },
      },
    });
    expect(people.paymentInfoCalls).toEqual([
      { from: prepared.account.address, options: prepared.options },
      { from: prepared.account.address, options: prepared.options },
    ]);
    expect(people.deliveryFactorParas).toEqual([PASEO_ASSET_HUB_PARA_ID]);
    expect(people.swaps.at(-1)).toMatchObject({
      path: [PUSD_LOCATION, NATIVE_LOCATION],
      amount_out: 1_014_560_000n,
      amount_in_max: 203_527_729_981n,
      send_to: prepared.account.address,
      keep_alive: true,
    });
    expect(people.xcms.at(-1)).toMatchObject({
      max_weight: LOCAL_XCM_MAX_WEIGHT,
      message: {
        type: "V5",
        value: [
          {
            type: "WithdrawAsset",
            value: [
              { id: NATIVE_LOCATION, fun: { type: "Fungible", value: 1_014_560_000n } },
              {
                id: PUSD_LOCATION,
                fun: {
                  type: "Fungible",
                  value: 1_796_472_270_008n,
                },
              },
            ],
          },
          { type: "InitiateTeleport" },
        ],
      },
    });
    expect(
      people.reads.some(
        (read) =>
          Array.isArray(read) &&
          read[0] === "Assets.Account" &&
          read[3] &&
          (read[3] as { at?: string }).at === "finalized",
      ),
    ).toBe(true);
    expect(assetHub.reads).toEqual([
      [PUSD_ASSET_ID, prepared.account.address, { at: "finalized" }],
    ]);
  });

  it("uses the People native ED when it is higher than delivery and remote execution", async () => {
    const people = fakePeopleApi({
      peopleNativeMinimum: 5_000_000_000n,
      deliveryFactor: FIXED_POINT_SCALE,
    });
    const assetHub = fakeAssetHubApi({ nativeMinimum: 1n });

    const prepared = await prepareWithdrawalTransaction({
      peopleApi: people.api,
      assetHubApi: assetHub.api,
      publicKey: PUBLIC_KEY,
    });

    expect(prepared.amounts.pasToSwap).toBe(5_000_000_000n);
    expect(people.swaps.at(-1)).toMatchObject({ amount_out: 5_000_000_000n });
  });

  it("rejects missing, zero, or negative fee rates", async () => {
    for (const rate of [undefined, 0n, -1n]) {
      await expect(
        prepareWithdrawalTransaction({
          peopleApi: fakePeopleApi({ rate }).api,
          assetHubApi: fakeAssetHubApi().api,
          publicKey: PUBLIC_KEY,
        }),
      ).rejects.toThrow(/no pUSD transaction-fee rate/);
    }
  });

  it("rejects empty pool liquidity, exhausted native reserve, bad delivery factor, and bad keys", async () => {
    await expect(
      prepareWithdrawalTransaction({
        peopleApi: fakePeopleApi({ poolPUsd: 0n }).api,
        assetHubApi: fakeAssetHubApi().api,
        publicKey: PUBLIC_KEY,
      }),
    ).rejects.toThrow(/no usable liquidity/);

    await expect(
      prepareWithdrawalTransaction({
        peopleApi: fakePeopleApi({ poolPas: 1n }).api,
        assetHubApi: fakeAssetHubApi().api,
        publicKey: PUBLIC_KEY,
      }),
    ).rejects.toThrow(/pool liquidity/);

    await expect(
      prepareWithdrawalTransaction({
        peopleApi: fakePeopleApi({ deliveryFactor: 0n }).api,
        assetHubApi: fakeAssetHubApi().api,
        publicKey: PUBLIC_KEY,
      }),
    ).rejects.toThrow(/delivery-fee multiplier/);

    await expect(
      prepareWithdrawalTransaction({
        peopleApi: fakePeopleApi({ peopleBalance: 0n }).api,
        assetHubApi: fakeAssetHubApi().api,
        publicKey: PUBLIC_KEY,
      }),
    ).rejects.toThrow(/no finalized CASH/);

    await expect(
      prepareWithdrawalTransaction({
        peopleApi: fakePeopleApi().api,
        assetHubApi: fakeAssetHubApi().api,
        publicKey: new Uint8Array(31),
      }),
    ).rejects.toThrow(/32 bytes/);
  });

  it("rejects balances that cannot cover swap or transaction fees with formatted pUSD", async () => {
    await expect(
      prepareWithdrawalTransaction({
        peopleApi: fakePeopleApi({
          peopleBalance: 1_000_000n,
          poolPUsd: 1_000_000_000_000_000n,
          poolPas: 10_000_000_000n,
        }).api,
        assetHubApi: fakeAssetHubApi().api,
        publicKey: PUBLIC_KEY,
      }),
    ).rejects.toThrow(/The 1 pUSD balance is too small\./);

    await expect(
      prepareWithdrawalTransaction({
        peopleApi: fakePeopleApi({
          peopleBalance: 1_000_000_000_000n,
          partialFees: [3_000_000_000_000_000_000n],
        }).api,
        assetHubApi: fakeAssetHubApi().api,
        publicKey: PUBLIC_KEY,
      }),
    ).rejects.toThrow(/credit at least .* pUSD plus transaction fees/);
  });
});
