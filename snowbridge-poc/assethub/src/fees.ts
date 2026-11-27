import type { ApiPromise } from "@polkadot/api";
import type { Hex } from "viem";
import { ETHEREUM_CHAIN_ID } from "./constants.js";
import { deliveredProgram, type BridgeMessage } from "./delivered.js";
import { etherLocation } from "./location.js";
import { encodeVersionedXcm, type Instruction } from "./xcm.js";

export interface Quote {
  program: Hex;
  weight: { refTime: number; proofSize: number };
  /** Ether, in wei, that pays for the weight of the whole delivered program. */
  fee: bigint;
}

/** Weighs the program Bridge Hub would deliver for `message` and prices the weight in ether. */
export async function quoteDelivery(api: ApiPromise, message: BridgeMessage, beforeUserProgram: Instruction[] = []): Promise<Quote> {
  const program = encodeVersionedXcm(api, deliveredProgram(api, message, beforeUserProgram));
  const weight = ((await api.call.xcmPaymentApi.queryXcmWeight(program)).toJSON() as { ok: { refTime: number; proofSize: number } }).ok;
  const fee = ((await api.call.xcmPaymentApi.queryWeightToAssetFee(weight, { V5: etherLocation(ETHEREUM_CHAIN_ID) })).toJSON() as { ok: number | string }).ok;
  return { program, weight, fee: BigInt(fee) };
}
