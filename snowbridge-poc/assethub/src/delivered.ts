import type { Codec } from "@polkadot/types/types";
import { blake2AsU8a } from "@polkadot/util-crypto";
import { bnToU8a, u8aConcat, u8aToHex } from "@polkadot/util";
import type { Address, Hex } from "viem";
import { ETHEREUM_CHAIN_ID, INBOUND_QUEUE_V2_PALLET } from "./constants.js";
import { ethereumAccountLocation, ethereumJunction, etherLocation } from "./location.js";
import type { Instruction, TypeFactory } from "./xcm.js";

export interface BridgeMessage {
  /** The Ethereum account that called the Gateway: the router. */
  router: Address;
  nonce: bigint;
  /** The `xcm` bytes passed to `v2_sendMessage`. */
  xcm: Hex;
  /** The `claimer` bytes passed to `v2_sendMessage`. */
  claimer: Hex;
  /** Ether carried on top of the two fees. */
  value: bigint;
  executionFee: bigint;
  /** Ethereum-native ERC-20s only: Bridge Hub delivers Polkadot-native tokens as a `WithdrawAsset`, which is not modelled. */
  assets: { token: Address; amount: bigint; polkadotNative?: boolean }[];
}

const TOPIC_PREFIX = "SnowbridgeInboundQueueV2";

/** The topic Bridge Hub appends when the program does not end with one. */
export function inboundTopic(nonce: bigint): Hex {
  const text = new TextEncoder().encode(TOPIC_PREFIX);
  const scaleEncoded = u8aConcat(Uint8Array.of(text.length << 2), text, bnToU8a(nonce, { bitLength: 64, isLe: true }));
  return u8aToHex(blake2AsU8a(scaleEncoded, 256));
}

const fungible = (id: unknown, amount: bigint) => ({ id, fun: { Fungible: amount } });

/** Mirrors `MessageToXcm::convert` (v2), throwing on an xcm or claimer Bridge Hub would silently replace; `beforeUserProgram` is dry-run only. */
export function deliveredProgram(api: TypeFactory, message: BridgeMessage, beforeUserProgram: Instruction[] = []): Instruction[] {
  if (message.assets.some((asset) => asset.polkadotNative)) throw new Error("Polkadot-native tokens are not modelled");
  const ether = etherLocation(ETHEREUM_CHAIN_ID);
  const fee = fungible(ether, message.executionFee);

  const claimer = api.createType("StagingXcmV5Location", message.claimer);
  if (u8aToHex(claimer.toU8a()) !== message.claimer.toLowerCase()) throw new Error("claimer is not exactly one Location");

  const program = api.createType("XcmVersionedXcm", message.xcm) as unknown as Codec & {
    isV5: boolean;
    asV5: (Codec & { isSetTopic: boolean })[];
  };
  if (u8aToHex(program.toU8a()) !== message.xcm.toLowerCase()) throw new Error("xcm is not exactly one VersionedXcm");
  if (!program.isV5) throw new Error("xcm is not a V5 program");
  const userInstructions = program.asV5;

  const carried = [
    ...(message.value > 0n ? [fungible(ether, message.value)] : []),
    ...[...message.assets]
      .sort((a, b) => (a.token.toLowerCase() < b.token.toLowerCase() ? -1 : 1))
      .map(({ token, amount }) => fungible(ethereumAccountLocation(ETHEREUM_CHAIN_ID, token), amount)),
  ];
  const endsWithTopic = userInstructions.length > 0 && userInstructions[userInstructions.length - 1]!.isSetTopic;

  return [
    { DescendOrigin: { X1: [{ PalletInstance: INBOUND_QUEUE_V2_PALLET }] } },
    { UniversalOrigin: ethereumJunction(ETHEREUM_CHAIN_ID) },
    { ReserveAssetDeposited: [fee] },
    { SetHints: { hints: [{ AssetClaimer: { location: message.claimer } }] } },
    { PayFees: { asset: fee } },
    ...(carried.length > 0 ? [{ ReserveAssetDeposited: carried }] : []),
    { DescendOrigin: { X1: [{ AccountKey20: { network: null, key: message.router } }] } },
    ...beforeUserProgram,
    ...userInstructions.map((instruction) => u8aToHex(instruction.toU8a())),
    ...(endsWithTopic ? [] : [{ SetTopic: inboundTopic(message.nonce) }]),
  ];
}
