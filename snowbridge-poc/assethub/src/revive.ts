import type { ApiPromise } from "@polkadot/api";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type { KeyringPair } from "@polkadot/keyring/types";
import type { Option, u32 } from "@polkadot/types";
import type { Codec } from "@polkadot/types/types";
import type { EventRecord } from "@polkadot/types/interfaces";
import { hexToU8a, u8aToHex } from "@polkadot/util";
import type { Address, Hex } from "viem";
import { ETHEREUM_CHAIN_ID, FOREIGN_ASSETS_PRECOMPILE_SUFFIX } from "./constants.js";
import { ethereumAccountLocation, reviveAddress } from "./location.js";

export interface Included {
  blockHash: Hex;
  extrinsicHash: Hex;
  events: EventRecord[];
}

/** Index of a registered Ethereum ERC-20 in the foreign-assets precompile mapping. */
export async function foreignAssetIndex(api: ApiPromise, token: Address): Promise<number> {
  const index = (await api.query.assetsPrecompiles.foreignAssetIdToAssetIndex(
    ethereumAccountLocation(ETHEREUM_CHAIN_ID, token),
  )) as unknown as Option<u32>;
  if (index.isNone) throw new Error(`${token} is not a registered foreign asset on Asset Hub`);
  return index.unwrap().toNumber();
}

/** Refuses an ERC-20 precompile address that is not the foreign-assets precompile of exactly this token. */
export async function assertPrecompileIsFor(api: ApiPromise, precompile: Address, token: Address): Promise<void> {
  const bytes = hexToU8a(precompile);
  const fixedPart = u8aToHex(bytes.subarray(4));
  if (fixedPart !== `0x${"00".repeat(12)}${FOREIGN_ASSETS_PRECOMPILE_SUFFIX}`) {
    throw new Error(`${precompile} is not a foreign-assets ERC-20 precompile address`);
  }
  const index = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
  const mapped = (await api.query.assetsPrecompiles.assetIndexToForeignAssetId(index)) as unknown as Option<Codec>;
  const expected = api.createType("StagingXcmV5Location", ethereumAccountLocation(ETHEREUM_CHAIN_ID, token));
  if (mapped.isNone || mapped.unwrap().toHex() !== expected.toHex()) {
    throw new Error(`asset index ${index} of ${precompile} is not the foreign asset of ${token}`);
  }
}

export async function isMapped(api: ApiPromise, account: Hex): Promise<boolean> {
  const mapped = (await api.query.revive.originalAccount(reviveAddress(account))) as unknown as Option<Codec>;
  return mapped.isSome;
}

export function signAndWait(api: ApiPromise, tx: SubmittableExtrinsic<"promise">, signer: KeyringPair): Promise<Included> {
  return new Promise((resolve, reject) => {
    tx.signAndSend(signer, (result) => {
      if (result.dispatchError) {
        const { dispatchError } = result;
        const meta = dispatchError.isModule ? api.registry.findMetaError(dispatchError.asModule) : undefined;
        reject(new Error(`dispatch failed: ${meta ? `${meta.section}.${meta.name}` : dispatchError.toString()}`));
      } else if (result.isInBlock) {
        resolve({
          blockHash: result.status.asInBlock.toHex(),
          extrinsicHash: result.txHash.toHex(),
          events: result.events,
        });
      } else if (result.isError) {
        reject(new Error(`extrinsic rejected: ${result.status.toString()}`));
      }
    }).catch(reject);
  });
}

export interface DryCall {
  reverted: boolean;
  /** Return data, or the revert data when `reverted`. */
  output: Hex;
  weight: { refTime: bigint; proofSize: bigint };
  storageDeposit: bigint;
}

/** Simulates a call through the runtime API, as `eth_call` and `eth_estimateGas` would. */
export async function dryRunCall(api: ApiPromise, origin: Hex, dest: Address, data: Hex): Promise<DryCall> {
  const result = (await api.call.reviveApi.call(origin, dest, 0, null, null, data)).toJSON() as {
    weightRequired: { refTime: number; proofSize: number };
    maxStorageDeposit: { charge?: number | string };
    result: { ok?: { flags: { bits: number }; data: Hex }; err?: unknown };
  };
  if (!result.result.ok) throw new Error(`call failed: ${JSON.stringify(result.result.err)}`);
  return {
    reverted: result.result.ok.flags.bits !== 0,
    output: result.result.ok.data,
    weight: { refTime: BigInt(result.weightRequired.refTime), proofSize: BigInt(result.weightRequired.proofSize) },
    storageDeposit: BigInt(result.maxStorageDeposit.charge ?? 0),
  };
}

/** Read-only call of a contract. */
export async function callView(api: ApiPromise, origin: Hex, dest: Address, data: Hex): Promise<Hex> {
  const dry = await dryRunCall(api, origin, dest, data);
  if (dry.reverted) throw new Error(`call reverted: ${dry.output}`);
  return dry.output;
}

/** Sends a contract call as `signer`, with the weight and deposit limits the simulation asks for plus 30%. */
export async function submitCall(api: ApiPromise, signer: KeyringPair, dest: Address, data: Hex): Promise<Included> {
  const dry = await dryRunCall(api, u8aToHex(signer.publicKey), dest, data);
  if (dry.reverted) throw new Error(`call would revert: ${dry.output}`);
  const weight = { refTime: (dry.weight.refTime * 13n) / 10n, proofSize: (dry.weight.proofSize * 13n) / 10n };
  return signAndWait(api, api.tx.revive.call(dest, 0, weight, (dry.storageDeposit * 13n) / 10n + 1_000_000_000n, data), signer);
}

export async function foreignBalance(api: ApiPromise, token: Address, account: string): Promise<bigint> {
  const held = (await api.query.foreignAssets.account(ethereumAccountLocation(ETHEREUM_CHAIN_ID, token), account)) as unknown as {
    isSome: boolean;
    unwrap(): { balance: { toBigInt(): bigint } };
  };
  return held.isSome ? held.unwrap().balance.toBigInt() : 0n;
}
