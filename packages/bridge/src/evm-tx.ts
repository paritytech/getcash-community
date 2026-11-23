// An EIP-1559 Ethereum transaction: its bytes, its signature and the address of the key that
// signs it. getcash signs its own Ethereum transactions on purpose, so that a top-up needs no
// forwarder contract and no relayer.
// TODO: remove this file once a forwarder and a relayer send the transactions.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";

/** What RLP encodes: bytes, or a list of such items. */
export type RlpItem = Uint8Array | RlpItem[];

/** A whole number as RLP takes it: big endian with no leading zero, and no byte at all for zero. */
export function integerBytes(value: bigint): Uint8Array {
  if (value < 0n) throw new Error("a negative number has no RLP form");
  if (value === 0n) return new Uint8Array(0);
  const hex = value.toString(16);
  return hexToBytes(hex.length % 2 === 0 ? hex : `0${hex}`);
}

/** The prefix of a string or a list of `length` bytes. `offset` is 0x80 for a string and 0xc0 for
 *  a list. */
function lengthPrefix(length: number, offset: number): Uint8Array {
  if (length < 56) return Uint8Array.of(offset + length);
  const size = integerBytes(BigInt(length));
  return Uint8Array.of(offset + 55 + size.length, ...size);
}

/** The RLP encoding of `item`. */
export function rlpEncode(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0]! < 0x80) return item;
    return concatBytes(lengthPrefix(item.length, 0x80), item);
  }
  const body = concatBytes(...item.map(rlpEncode));
  return concatBytes(lengthPrefix(body.length, 0xc0), body);
}

/** The 20 bytes of an address written as 0x and 40 hex digits. */
export function addressBytes(address: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`not an Ethereum address: ${address}`);
  return hexToBytes(address.slice(2));
}

/** The address of a private key, in lower case. */
export function evmAddressOf(privateKey: Uint8Array): string {
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  return `0x${bytesToHex(keccak_256(publicKey.subarray(1)).subarray(12))}`;
}

export interface EvmTransaction {
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  /** The account or contract called. */
  to: string;
  value: bigint;
  data: Uint8Array;
}

export interface SignedEvmTransaction {
  /** The bytes a node takes. */
  raw: Uint8Array;
  hash: Uint8Array;
}

/** The type byte of an EIP-1559 transaction. */
const EIP_1559 = 0x02;

const typed = (payload: RlpItem[]): Uint8Array =>
  concatBytes(Uint8Array.of(EIP_1559), rlpEncode(payload));

/** Signs `tx` with `privateKey`. The access list is empty. */
export function signEvmTransaction(
  tx: EvmTransaction,
  privateKey: Uint8Array,
): SignedEvmTransaction {
  const fields: RlpItem[] = [
    integerBytes(tx.chainId),
    integerBytes(tx.nonce),
    integerBytes(tx.maxPriorityFeePerGas),
    integerBytes(tx.maxFeePerGas),
    integerBytes(tx.gasLimit),
    addressBytes(tx.to),
    integerBytes(tx.value),
    tx.data,
    [],
  ];
  // The recovered form is the parity byte, then r and s at 32 bytes each.
  const signature = secp256k1.sign(keccak_256(typed(fields)), privateKey, {
    prehash: false,
    format: "recovered",
  });
  const parity = signature[0]!;
  if (parity > 1) throw new Error("the signature has no parity Ethereum accepts");
  const r = BigInt(`0x${bytesToHex(signature.subarray(1, 33))}`);
  const s = BigInt(`0x${bytesToHex(signature.subarray(33, 65))}`);
  const raw = typed([...fields, integerBytes(BigInt(parity)), integerBytes(r), integerBytes(s)]);
  return { raw, hash: keccak_256(raw) };
}
