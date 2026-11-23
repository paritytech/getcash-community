// The ABI encoding of a contract call, and the reading of what a call returns. It covers the
// argument kinds the bridge routes use: single words, bytes and lists of bytes. The reads of the
// route checks need numbers and addresses only. The bytes, the lists of bytes and the 32 byte
// values serve the transactions getcash signs itself, which it does on purpose so that a top-up
// needs no forwarder contract and no relayer.
// TODO: remove the bytes, the lists of bytes and the 32 byte values once a forwarder and a
// relayer send the transactions.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

const WORD = 32;
const LARGEST_WORD = (1n << 256n) - 1n;

/** One argument of a call. A struct with no bytes in it is passed as its fields, one word each. */
export type AbiArgument =
  | { kind: "word"; value: Uint8Array }
  | { kind: "bytes"; value: Uint8Array }
  | { kind: "bytesList"; value: Uint8Array[] };

/** The 20 bytes of an address written as 0x and 40 hex digits. */
export function addressBytes(address: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`not an Ethereum address: ${address}`);
  return hexToBytes(address.slice(2));
}

/** A whole number as one word. */
function numberWord(value: bigint): Uint8Array {
  if (value < 0n || value > LARGEST_WORD) throw new Error("the number does not fit one word");
  return hexToBytes(value.toString(16).padStart(WORD * 2, "0"));
}

/** A whole number of any unsigned width. */
export const abiUint = (value: bigint): AbiArgument => ({ kind: "word", value: numberWord(value) });

/** An address. */
export const abiAddress = (address: string): AbiArgument => ({
  kind: "word",
  value: concatBytes(new Uint8Array(WORD - 20), addressBytes(address)),
});

/** `value`, which must be exactly one word long. */
function wholeWord(value: Uint8Array): Uint8Array {
  if (value.length !== WORD) throw new Error("a word is 32 bytes");
  return value;
}

/** A value of exactly 32 bytes. */
export const abiWord = (value: Uint8Array): AbiArgument => ({
  kind: "word",
  value: wholeWord(value),
});

/** Bytes of any length. */
export const abiBytes = (value: Uint8Array): AbiArgument => ({ kind: "bytes", value });

/** A list of bytes of any length. */
export const abiBytesList = (value: Uint8Array[]): AbiArgument => ({ kind: "bytesList", value });

/** The first four bytes of the hash of a function's signature, which name it in a call. */
export function selector(signature: string): Uint8Array {
  return keccak_256(utf8ToBytes(signature)).subarray(0, 4);
}

/** The length of `value`, then `value` filled with zeros up to a whole word. */
function encodeBytes(value: Uint8Array): Uint8Array {
  const padding = (WORD - (value.length % WORD)) % WORD;
  return concatBytes(numberWord(BigInt(value.length)), value, new Uint8Array(padding));
}

/** A part of an encoding: one word in place, or bytes that go after the words. */
type Part = { word: Uint8Array } | { tail: Uint8Array };

/** One word in the head for each part, and each part with bytes in it after the head, where its
 *  word in the head says it starts. */
function encodeParts(parts: Part[]): Uint8Array {
  const heads: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  let offset = parts.length * WORD;
  for (const part of parts) {
    if ("word" in part) {
      heads.push(part.word);
      continue;
    }
    heads.push(numberWord(BigInt(offset)));
    tails.push(part.tail);
    offset += part.tail.length;
  }
  return concatBytes(...heads, ...tails);
}

function encodeBytesList(list: Uint8Array[]): Uint8Array {
  const items = list.map((item): Part => ({ tail: encodeBytes(item) }));
  return concatBytes(numberWord(BigInt(list.length)), encodeParts(items));
}

/** The data of a call to the function with `signature`, with `args` in order. */
export function encodeCall(signature: string, args: AbiArgument[] = []): Uint8Array {
  const parts = args.map((arg): Part => {
    if (arg.kind === "word") return { word: wholeWord(arg.value) };
    return { tail: arg.kind === "bytes" ? encodeBytes(arg.value) : encodeBytesList(arg.value) };
  });
  return concatBytes(selector(signature), encodeParts(parts));
}

/** The word at position `index` of what a call returned, as a whole number. */
export function wordAt(returned: Uint8Array, index: number): bigint {
  const start = index * WORD;
  if (index < 0 || returned.length < start + WORD) {
    throw new Error(`the call returned no word at position ${index}`);
  }
  return BigInt(`0x${bytesToHex(returned.subarray(start, start + WORD))}`);
}
