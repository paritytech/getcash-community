import type { ApiPromise } from "@polkadot/api";
import { u8aToHex } from "@polkadot/util";
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, type Address, type Hex } from "viem";
import { accountLocation } from "./location.js";

/** Anything that builds runtime types by name: an `ApiPromise` or a `TypeRegistry` holding the runtime's metadata. */
export type TypeFactory = Pick<ApiPromise, "createType">;

/** An instruction as the codec accepts it: a JSON value or its encoded bytes. */
export type Instruction = Record<string, unknown> | Hex;

export interface Weight {
  refTime: bigint;
  proofSize: bigint;
}

export const settleAbi = parseAbi([
  "function settle(uint256 depositId, bytes32 account, address token, uint256 amount)",
]);
export const settleArgsAbi = parseAbiParameters("uint256 depositId, bytes32 account, address token, uint256 amount");
/** Selector plus four ABI words. */
export const SETTLE_CALLDATA_LENGTH = 132;

export interface SettleArgs {
  depositId: bigint;
  account: Hex;
  token: Address;
  amount: bigint;
}

export function settleCalldata({ depositId, account, token, amount }: SettleArgs): Hex {
  return encodeFunctionData({ abi: settleAbi, functionName: "settle", args: [depositId, account, token, amount] });
}

export function settleArgsEncoding({ depositId, account, token, amount }: SettleArgs): Hex {
  return encodeAbiParameters(settleArgsAbi, [depositId, account, token, amount]);
}

/** The SCALE bytes of `Revive.call(pool, 0, weight, depositLimit, data)`, call index included. */
export function reviveCall(api: ApiPromise, pool: Address, data: Hex, weight: Weight, storageDepositLimit: bigint): Hex {
  return api.tx.revive.call(pool, 0, weight, storageDepositLimit, data).method.toHex();
}

export function mapAccountCall(api: ApiPromise): Hex {
  return api.tx.revive.mapAccount().method.toHex();
}

export function transactAsSovereign(call: Hex): Instruction {
  return { Transact: { originKind: "SovereignAccount", fallbackMaxWeight: null, call: { encoded: call } } };
}

export const depositAll = (beneficiary: Hex): Instruction => ({
  DepositAsset: { assets: { Wild: "All" }, beneficiary: accountLocation(beneficiary) },
});

/** The router's program: pay the pool, settle (a failed settle aborts the program), return the unspent fee to the fee account. */
export function routerProgram(poolAccount: Hex, feeAccount: Hex, settleCall: Hex): Instruction[] {
  return [
    depositAll(poolAccount),
    transactAsSovereign(settleCall),
    { ExpectTransactStatus: "Success" },
    { RefundSurplus: null },
    depositAll(feeAccount),
  ];
}

export function encodeVersionedXcm(api: TypeFactory, instructions: Instruction[]): Hex {
  return u8aToHex(api.createType("XcmVersionedXcm", { V5: instructions }).toU8a());
}
