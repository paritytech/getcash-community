import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";
import { withTimeout } from "../../lib/timeout";
import type { Hex32, WithdrawalAccount } from "./account";
import { withdrawalAccountFromPublicKey } from "./account";
import {
  HOST_QUERY_TIMEOUT_MS,
  LOCAL_XCM_MAX_WEIGHT,
  PASEO_ASSET_HUB_PARA_ID,
  POOL_ACCOUNT,
  PUSD_ASSET_ID,
} from "./constants";
import { createDrainXcmArgs, NATIVE_LOCATION, PUSD_LOCATION } from "./locations";
import {
  addXcmFeeMargin,
  deliveryFeeForEncodedXcm,
  formatPUsd,
  maxBigInt,
  nativeFeeToPUsd,
  type PoolReserves,
  quoteExactOutput,
  remoteExecutionFeeWithMargin,
} from "./quote";

export type PeopleApi = TypedApi<typeof paseo_people_next>;
export type AssetHubApi = TypedApi<typeof paseo_next_v2>;
export type PeopleBatchTransaction = ReturnType<PeopleApi["tx"]["Utility"]["batch_all"]>;
export type PeopleTransactionOptions = Parameters<PeopleBatchTransaction["getPaymentInfo"]>[1];

type PeopleBatchCall = Parameters<PeopleApi["tx"]["Utility"]["batch_all"]>[0]["calls"][number];

export interface PaymentInfoPass {
  partialFeeNative: bigint;
  feePUsd: bigint;
  transferAmount: bigint;
}

export interface PreparedWithdrawalAmounts {
  peopleBalance: bigint;
  assetHubBalanceBefore: bigint;
  pUsdTransfer: bigint;
  maxPUsdSwapInput: bigint;
  pasToSwap: bigint;
  pasForRemoteExecution: bigint;
  remoteExecutionFee: bigint;
  deliveryFee: bigint;
  deliveryFeeWithMargin: bigint;
  peopleNativeMinimum: bigint;
  assetHubNativeMinimum: bigint;
  encodedSizingXcmBytes: number;
}

export interface PreparedWithdrawalTransaction {
  account: WithdrawalAccount;
  transaction: PeopleBatchTransaction;
  options: PeopleTransactionOptions;
  amounts: PreparedWithdrawalAmounts;
  pool: PoolReserves;
  paymentInfoPasses: PaymentInfoPass[];
}

export interface PrepareWithdrawalTransactionInput {
  peopleApi: PeopleApi;
  assetHubApi: AssetHubApi;
  publicKey: Uint8Array;
  queryTimeoutMs?: number;
}

export const PEOPLE_TRANSACTION_OPTIONS = {
  asset: PUSD_LOCATION,
  customSignedExtensions: {
    VerifyMultiSignature: { value: { type: "Disabled", value: undefined } },
  },
} satisfies PeopleTransactionOptions;

export async function prepareWithdrawalTransaction(
  input: PrepareWithdrawalTransactionInput,
): Promise<PreparedWithdrawalTransaction> {
  const account = withdrawalAccountFromPublicKey(input.publicKey);
  const queryTimeoutMs = input.queryTimeoutMs ?? HOST_QUERY_TIMEOUT_MS;
  const balance = await readPeopleBalance(input.peopleApi, account.address, queryTimeoutMs);
  if (balance <= 0n) {
    throw new Error("This disposable key has no finalized CASH on People Chain.");
  }

  const [
    rate,
    assetHubBalanceBefore,
    pool,
    deliveryFactor,
    peopleNativeMinimum,
    assetHubNativeMinimum,
  ] = await Promise.all([
    withTimeout(
      input.peopleApi.query.AssetRate.ConversionRateToNative.getValue(PUSD_LOCATION),
      queryTimeoutMs,
      "People fee-rate query",
    ),
    readAssetHubBalance(input.assetHubApi, account.address, queryTimeoutMs),
    readPoolReserves(input.peopleApi, queryTimeoutMs),
    withTimeout(
      input.peopleApi.query.XcmpQueue.DeliveryFeeFactor.getValue(PASEO_ASSET_HUB_PARA_ID),
      queryTimeoutMs,
      "XCMP delivery-fee query",
    ),
    withTimeout(
      input.peopleApi.constants.Balances.ExistentialDeposit(),
      queryTimeoutMs,
      "People native minimum-balance query",
    ),
    withTimeout(
      input.assetHubApi.constants.Balances.ExistentialDeposit(),
      queryTimeoutMs,
      "Asset Hub native minimum-balance query",
    ),
  ]);
  if (!rate || rate <= 0n) throw new Error("The People runtime has no pUSD transaction-fee rate.");
  if (deliveryFactor <= 0n) throw new Error("The XCMP delivery-fee multiplier is unavailable.");

  const remoteExecutionFee = remoteExecutionFeeWithMargin();
  const pasForRemoteExecution = assetHubNativeMinimum + remoteExecutionFee;
  const sizingXcm = createDrainXcm(input.peopleApi, {
    pUsdAmount: balance,
    pasAmount: peopleNativeMinimum,
    pasForRemoteExecution,
    beneficiaryHex: account.publicKeyHex,
  });
  const encodedSizingXcm = await sizingXcm.getEncodedData();
  const deliveryFee = deliveryFeeForEncodedXcm(encodedSizingXcm.length, deliveryFactor);
  const deliveryFeeWithMargin = addXcmFeeMargin(deliveryFee);
  const pasToSwap = maxBigInt(peopleNativeMinimum, deliveryFeeWithMargin + pasForRemoteExecution);
  const maxPUsdSwapInput = quoteExactOutput(pool.pUsd, pool.pas, pasToSwap);

  let transferAmount = balance - maxPUsdSwapInput;
  if (transferAmount <= 0n) {
    throw new Error(
      `The ${formatPUsd(balance)} pUSD balance is too small. The XCM swap may use up to ${formatPUsd(maxPUsdSwapInput)} pUSD before transaction fees.`,
    );
  }

  let transaction = createSwapAndTransferBatch(input.peopleApi, {
    account,
    pasToSwap,
    pasForRemoteExecution,
    maxPUsdSwapInput,
    transferAmount,
  });
  const paymentInfoPasses: PaymentInfoPass[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const paymentInfo = await transaction.getPaymentInfo(
      account.address,
      PEOPLE_TRANSACTION_OPTIONS,
    );
    const feePUsd = nativeFeeToPUsd(paymentInfo.partial_fee, rate);
    transferAmount = balance - maxPUsdSwapInput - feePUsd;
    paymentInfoPasses.push({
      partialFeeNative: paymentInfo.partial_fee,
      feePUsd,
      transferAmount,
    });
    if (transferAmount <= 0n) break;
    transaction = createSwapAndTransferBatch(input.peopleApi, {
      account,
      pasToSwap,
      pasForRemoteExecution,
      maxPUsdSwapInput,
      transferAmount,
    });
  }
  if (transferAmount <= 0n) {
    const minimum = maxPUsdSwapInput + 1n;
    throw new Error(
      `The ${formatPUsd(balance)} pUSD balance is too small. The XCM swap alone may use up to ${formatPUsd(maxPUsdSwapInput)} pUSD; credit at least ${formatPUsd(minimum)} pUSD plus transaction fees.`,
    );
  }

  return {
    account,
    transaction,
    options: PEOPLE_TRANSACTION_OPTIONS,
    amounts: {
      peopleBalance: balance,
      assetHubBalanceBefore,
      pUsdTransfer: transferAmount,
      maxPUsdSwapInput,
      pasToSwap,
      pasForRemoteExecution,
      remoteExecutionFee,
      deliveryFee,
      deliveryFeeWithMargin,
      peopleNativeMinimum,
      assetHubNativeMinimum,
      encodedSizingXcmBytes: encodedSizingXcm.length,
    },
    pool,
    paymentInfoPasses,
  };
}

export function createSwapAndTransferBatch(
  api: PeopleApi,
  args: {
    account: Pick<WithdrawalAccount, "address" | "publicKeyHex">;
    pasToSwap: bigint;
    pasForRemoteExecution: bigint;
    maxPUsdSwapInput: bigint;
    transferAmount: bigint;
  },
): PeopleBatchTransaction {
  const swap = api.tx.AssetConversion.swap_tokens_for_exact_tokens({
    path: [PUSD_LOCATION, NATIVE_LOCATION],
    amount_out: args.pasToSwap,
    amount_in_max: args.maxPUsdSwapInput,
    send_to: args.account.address,
    keep_alive: true,
  });
  const transfer = createDrainXcm(api, {
    pUsdAmount: args.transferAmount,
    pasAmount: args.pasToSwap,
    pasForRemoteExecution: args.pasForRemoteExecution,
    beneficiaryHex: args.account.publicKeyHex,
  });
  return api.tx.Utility.batch_all({
    calls: [swap.decodedCall, transfer.decodedCall] as PeopleBatchCall[],
  });
}

export function createDrainXcm(
  api: PeopleApi,
  args: {
    pUsdAmount: bigint;
    pasAmount: bigint;
    pasForRemoteExecution: bigint;
    beneficiaryHex: Hex32;
  },
) {
  return api.tx.PolkadotXcm.execute({
    ...createDrainXcmArgs(args),
    max_weight: LOCAL_XCM_MAX_WEIGHT,
  });
}

export async function readPeopleBalance(
  api: PeopleApi,
  address: string,
  queryTimeoutMs = HOST_QUERY_TIMEOUT_MS,
): Promise<bigint> {
  const account = await withTimeout(
    api.query.Assets.Account.getValue(PUSD_LOCATION, address, { at: "finalized" }),
    queryTimeoutMs,
    "People balance query",
  );
  return account?.balance ?? 0n;
}

export async function readAssetHubBalance(
  api: AssetHubApi,
  address: string,
  queryTimeoutMs = HOST_QUERY_TIMEOUT_MS,
): Promise<bigint> {
  const account = await withTimeout(
    api.query.Assets.Account.getValue(PUSD_ASSET_ID, address, { at: "finalized" }),
    queryTimeoutMs,
    "Asset Hub balance query",
  );
  return account?.balance ?? 0n;
}

export async function readPoolReserves(
  api: PeopleApi,
  queryTimeoutMs = HOST_QUERY_TIMEOUT_MS,
): Promise<PoolReserves> {
  const [nativeAccount, assetAccount] = await Promise.all([
    withTimeout(
      api.query.System.Account.getValue(POOL_ACCOUNT),
      queryTimeoutMs,
      "Pool PAS reserve query",
    ),
    withTimeout(
      api.query.Assets.Account.getValue(PUSD_LOCATION, POOL_ACCOUNT),
      queryTimeoutMs,
      "Pool pUSD reserve query",
    ),
  ]);
  const reserves = { pas: nativeAccount?.data.free ?? 0n, pUsd: assetAccount?.balance ?? 0n };
  if (reserves.pas <= 0n || reserves.pUsd <= 0n) {
    throw new Error("The People pUSD/PAS pool has no usable liquidity.");
  }
  return reserves;
}
