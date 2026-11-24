// A Snowbridge message on Ethereum: the call to the Gateway that sends it, and the event with
// which the Gateway accepts it.

import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import {
  abiBytes,
  abiBytesList,
  abiUint,
  addressAt,
  bytesAt,
  encodeCall,
  wordAt,
  wordsFrom,
} from "../evm-abi";
import type { EvmLog } from "../evm-rpc";
import type { EvmTransactionCall } from "../evm-tx";
import { decodeXcm, encodeXcm, type XcmInstruction } from "./codec";
import { claimerHint } from "./program";
import type { SnowbridgeMessage } from "./wrapper";

export const ETHEREUM_CHAIN_ID = 1n;

/** Snowbridge's Gateway on Ethereum. */
export const SNOWBRIDGE_GATEWAY = "0x27ca963c279c93801941e1eb8799c23f407d68e7";

/** The topic of the event the Gateway emits for a message it accepts. */
export const ACCEPTED_TOPIC = "0x550e2067494b1736ea5573f2d19cdc0ac95b410fff161bf16f11c6229655ec9c";

/** The bytes of a program that only names a claimer, up to the claimer: the version, one
 *  instruction, the instruction that sets hints, one hint, the hint that names a claimer. */
const CLAIMER_PREFIX = Uint8Array.of(0x05, 0x04, 0x33, 0x04, 0x00);

/** A claimer as the Gateway takes it: the bytes of its location. */
export async function claimerBytes(location: unknown): Promise<Uint8Array> {
  const program = await encodeXcm([claimerHint(location)]);
  return program.subarray(CLAIMER_PREFIX.length);
}

/** The location in the bytes of a claimer. */
export async function claimerLocation(bytes: Uint8Array): Promise<unknown> {
  const [hint] = await decodeXcm(concatBytes(CLAIMER_PREFIX, bytes));
  const { hints } = hint!.value as { hints: [{ value: { location: unknown } }] };
  return hints[0].value.location;
}

/** The call that sends a message with ether only through the Gateway. `total` is all the ether
 *  sent with the call: the two fees and what the message carries on top of them. getcash sends
 *  this call from a key of its own on purpose, so that a top-up needs no forwarder contract and
 *  no relayer.
 *  TODO: remove this function once a forwarder sends the message. */
export async function gatewaySend(args: {
  program: XcmInstruction[];
  claimer: unknown;
  executionFee: bigint;
  relayerFee: bigint;
  total: bigint;
}): Promise<EvmTransactionCall> {
  if (args.total < args.executionFee + args.relayerFee) {
    throw new Error("the ether sent does not cover the two fees");
  }
  return {
    to: SNOWBRIDGE_GATEWAY,
    value: args.total,
    data: encodeCall("v2_sendMessage(bytes,bytes[],bytes,uint128,uint128)", [
      abiBytes(await encodeXcm(args.program)),
      abiBytesList([]),
      abiBytes(await claimerBytes(args.claimer)),
      abiUint(args.executionFee),
      abiUint(args.relayerFee),
    ]),
  };
}

/** A message as the Gateway's event carries it. */
export interface AcceptedMessage {
  /** The number the Gateway gave the message. */
  nonce: bigint;
  /** The account that called the Gateway, in lower case. */
  sender: string;
  /** The ether the message carries on top of its two fees, in wei. */
  value: bigint;
  executionFee: bigint;
  relayerFee: bigint;
  /** The bytes of the program. */
  program: Uint8Array;
  /** The bytes of the claimer. */
  claimer: Uint8Array;
  /** The tokens of Ethereum the message carries. */
  tokens: { token: string; amount: bigint }[];
}

/** The kind the Gateway gives a program sent as bytes, and a token of Ethereum. */
const RAW_PROGRAM = 0n;
const ETHEREUM_TOKEN = 0n;

/** The message in `log`, or null when the log is not the Gateway's event for an accepted
 *  message. The event holds the number of the message and its payload: the sender, the tokens,
 *  the program, the claimer, the value and the two fees. */
export function acceptedMessage(log: EvmLog): AcceptedMessage | null {
  if (log.address.toLowerCase() !== SNOWBRIDGE_GATEWAY) return null;
  if (log.topics[0]?.toLowerCase() !== ACCEPTED_TOPIC) return null;
  const { data } = log;
  const payload = wordsFrom(data, 0, 1);
  const tokensAt = wordsFrom(data, payload, payload + 1);
  const programAt = wordsFrom(data, payload, payload + 2);
  const claimerAt = wordsFrom(data, payload, payload + 3);

  if (wordAt(data, programAt) !== RAW_PROGRAM) {
    throw new Error("the message does not carry its program as bytes");
  }
  // Each token is a kind and bytes, and the bytes hold its address and its amount.
  const firstToken = tokensAt + 1;
  const tokens = Array.from({ length: Number(wordAt(data, tokensAt)) }, (_, index) => {
    const tokenAt = wordsFrom(data, firstToken, firstToken + index);
    if (wordAt(data, tokenAt) !== ETHEREUM_TOKEN) {
      throw new Error("the message carries a token that is not of Ethereum");
    }
    const token = bytesAt(data, wordsFrom(data, tokenAt, tokenAt + 1));
    return { token: addressAt(token, 0), amount: wordAt(token, 1) };
  });

  return {
    nonce: wordAt(data, 0),
    sender: addressAt(data, payload),
    value: wordAt(data, payload + 4),
    executionFee: wordAt(data, payload + 5),
    relayerFee: wordAt(data, payload + 6),
    program: bytesAt(data, wordsFrom(data, programAt, programAt + 1)),
    claimer: bytesAt(data, claimerAt),
    tokens,
  };
}

/** The accepted message as the copy of Bridge Hub's wrapper takes it. It throws for a program
 *  or a claimer it cannot read. Bridge Hub replaces those, as the wrapper says. */
export async function readAccepted(accepted: AcceptedMessage): Promise<SnowbridgeMessage> {
  let program: XcmInstruction[];
  let claimer: unknown;
  try {
    program = await decodeXcm(accepted.program);
  } catch {
    throw new Error(`the program of the message cannot be read: 0x${bytesToHex(accepted.program)}`);
  }
  try {
    claimer = await claimerLocation(accepted.claimer);
  } catch {
    throw new Error(`the claimer of the message cannot be read: 0x${bytesToHex(accepted.claimer)}`);
  }
  return {
    sender: accepted.sender,
    nonce: accepted.nonce,
    value: accepted.value,
    executionFee: accepted.executionFee,
    claimer,
    tokens: accepted.tokens,
    program,
  };
}
