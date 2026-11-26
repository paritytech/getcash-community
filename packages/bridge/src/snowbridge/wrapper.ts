// Our copy of what Bridge Hub puts around the program of a Snowbridge message before it sends the
// message to Asset Hub. Bridge Hub builds the real one, and this copy is never sent. It exists to
// run a message on Asset Hub in a dry run before any ether leaves Ethereum, and to weigh the
// message for its execution fee.
//
// The copy takes the claimer and the program as values. Bridge Hub takes them as bytes, and it
// replaces bytes it cannot read: an unreadable program becomes an empty one, and an unreadable
// claimer becomes Snowbridge's own account. The copy covers ether and the tokens of Ethereum. A
// token of Polkadot that returns from Ethereum takes one more instruction, which is left out.

import { blake2b } from "@noble/hashes/blake2.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { XcmInstruction } from "./codec";
import { claimerHint, ETHER, ETHEREUM } from "./program";

/** The pallet of Bridge Hub that receives the messages from Ethereum. */
const INBOUND_QUEUE_PALLET = 91;

/** What Bridge Hub hashes with the number of a message to make its topic. */
const TOPIC_PREFIX = utf8ToBytes("SnowbridgeInboundQueueV2");

/** A message as the Gateway on Ethereum accepted it. */
export interface SnowbridgeMessage {
  /** The Ethereum account that called the Gateway, as 0x and 40 hex digits. */
  sender: string;
  /** The number the Gateway gave the message. */
  nonce: bigint;
  /** The ether the message carries on top of its two fees, in wei. */
  value: bigint;
  /** The ether that pays for the message on Asset Hub, in wei. */
  executionFee: bigint;
  /** The location that can claim what a failure leaves on Asset Hub. */
  claimer: unknown;
  /** The tokens of Ethereum the message carries, in their base units. */
  tokens?: { token: string; amount: bigint }[];
  program: XcmInstruction[];
}

const fungible = (id: unknown, amount: bigint) => ({
  id,
  fun: { type: "Fungible", value: amount },
});

const isAddress = (value: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(value);

/** A token of Ethereum as Asset Hub names it. */
const tokenLocation = (token: string) => ({
  parents: 2,
  interior: {
    type: "X2",
    value: [ETHEREUM, { type: "AccountKey20", value: { network: undefined, key: token } }],
  },
});

/** The topic Bridge Hub gives a message whose program has none. It is also the id that Asset Hub
 *  reports for the message. */
export function snowbridgeTopic(nonce: bigint): string {
  if (nonce < 0n || nonce >= 1n << 64n) throw new Error("the nonce does not fit 64 bits");
  const number = new Uint8Array(8);
  new DataView(number.buffer).setBigUint64(0, nonce, true);
  // The SCALE bytes of the text and the number: the length of the text, the text, the number.
  const hashed = concatBytes(Uint8Array.of(TOPIC_PREFIX.length << 2), TOPIC_PREFIX, number);
  return `0x${bytesToHex(blake2b(hashed, { dkLen: 32 }))}`;
}

/** The assets the message carries besides its fee, as the chain codec orders a list of assets:
 *  the ether, then each token by its address, with one entry for each token. */
function carriedAssets(message: SnowbridgeMessage): unknown[] {
  const amounts = new Map<string, bigint>();
  for (const { token, amount } of message.tokens ?? []) {
    if (!isAddress(token) || BigInt(token) === 0n) throw new Error(`not a token: ${token}`);
    if (amount <= 0n) throw new Error("the amount of a token must be more than zero");
    const key = token.toLowerCase();
    amounts.set(key, (amounts.get(key) ?? 0n) + amount);
  }
  const tokens = [...amounts.keys()].sort();
  return [
    ...(message.value > 0n ? [fungible(ETHER, message.value)] : []),
    ...tokens.map((token) => fungible(tokenLocation(token), amounts.get(token)!)),
  ];
}

/** The whole program Asset Hub runs for `message`: what Bridge Hub delivers. */
export function deliveredProgram(message: SnowbridgeMessage): XcmInstruction[] {
  if (!isAddress(message.sender)) throw new Error(`not an Ethereum address: ${message.sender}`);
  if (message.value < 0n) throw new Error("the value is negative");
  if (message.executionFee <= 0n) throw new Error("the execution fee must be more than zero");
  const fee = fungible(ETHER, message.executionFee);
  const assets = carriedAssets(message);
  const { program } = message;
  // Bridge Hub keeps a topic the program ends with, and adds one when it has none.
  const hasTopic = program.at(-1)?.type === "SetTopic";
  return [
    {
      type: "DescendOrigin",
      value: { type: "X1", value: { type: "PalletInstance", value: INBOUND_QUEUE_PALLET } },
    },
    { type: "UniversalOrigin", value: ETHEREUM },
    { type: "ReserveAssetDeposited", value: [fee] },
    // The claimer is named before the fee is paid, so that it can claim even a message whose fee
    // is too low.
    claimerHint(message.claimer),
    { type: "PayFees", value: { asset: fee } },
    ...(assets.length > 0 ? [{ type: "ReserveAssetDeposited", value: assets }] : []),
    // From here the program runs as the account that called the Gateway. Bridge Hub leaves this
    // out only for a message the Gateway sends in its own name.
    {
      type: "DescendOrigin",
      value: {
        type: "X1",
        value: { type: "AccountKey20", value: { network: undefined, key: message.sender } },
      },
    },
    ...program,
    ...(hasTopic ? [] : [{ type: "SetTopic", value: snowbridgeTopic(message.nonce) }]),
  ];
}
