// The permit that lets an Ethereum key act on Hydration with no transaction of its own. The
// HOLLAR of a deposit arrives on the Hydration account of the key. That account holds nothing
// else, so it cannot pay for a signed transaction. It signs a permit for one call instead. Anyone
// can submit the permit, and the account pays the fee from its HOLLAR.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { addressBytes } from "../evm-abi";

/** The chain id of Hydration for the Ethereum side of it. */
export const HYDRATION_CHAIN_ID = 222_222n;

/** The contract of Hydration that checks a permit. */
const CALL_PERMIT = "0x000000000000000000000000000000000000080a";

/** The address a permit calls to run a call of the chain itself. */
const DISPATCH = "0x0000000000000000000000000000000000000401";

export interface HydrationPermit {
  /** The Ethereum address of the key that signs. */
  from: string;
  /** The call to run as that key's account, in the chain's own encoding. */
  call: Uint8Array;
  /** The most gas the call may use. The account pays for what it uses. */
  gasLimit: bigint;
  /** The number of permits the key has used so far. */
  nonce: bigint;
  /** The time the permit ends, in seconds. */
  deadline: bigint;
}

export interface PermitSignature {
  v: number;
  r: Uint8Array;
  s: Uint8Array;
}

/** A whole number as the 32 bytes a permit hashes. */
function word(value: bigint): Uint8Array {
  if (value < 0n || value >> 256n !== 0n) throw new Error("the number does not fit 32 bytes");
  return hexToBytes(value.toString(16).padStart(64, "0"));
}
const addressWord = (address: string): Uint8Array =>
  concatBytes(new Uint8Array(12), addressBytes(address));
const hashText = (text: string): Uint8Array => keccak_256(utf8ToBytes(text));

/** What ties a signature to Hydration and to its permit contract. */
const DOMAIN = keccak_256(
  concatBytes(
    hashText("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
    hashText("Call Permit Precompile"),
    hashText("1"),
    word(HYDRATION_CHAIN_ID),
    addressWord(CALL_PERMIT),
  ),
);

const PERMIT_TYPE = hashText(
  "CallPermit(address from,address to,uint256 value,bytes data,uint64 gaslimit,uint256 nonce,uint256 deadline)",
);

/** The 32 bytes the key signs for `permit`. */
export function permitDigest(permit: HydrationPermit): Uint8Array {
  const content = keccak_256(
    concatBytes(
      PERMIT_TYPE,
      addressWord(permit.from),
      addressWord(DISPATCH),
      word(0n),
      keccak_256(permit.call),
      word(permit.gasLimit),
      word(permit.nonce),
      word(permit.deadline),
    ),
  );
  return keccak_256(concatBytes(Uint8Array.of(0x19, 0x01), DOMAIN, content));
}

/** Signs `permit` with `privateKey`, which must be the key of `permit.from`. */
export function signPermit(permit: HydrationPermit, privateKey: Uint8Array): PermitSignature {
  // The recovered form is the parity byte, then r and s at 32 bytes each.
  const signature = secp256k1.sign(permitDigest(permit), privateKey, {
    prehash: false,
    format: "recovered",
  });
  return {
    v: 27 + signature[0]!,
    r: signature.subarray(1, 33),
    s: signature.subarray(33, 65),
  };
}

/** A whole number in the chain's own encoding of fixed size: the lowest byte first. */
function littleEndian(value: bigint, size: number): Uint8Array {
  if (value < 0n || value >> BigInt(8 * size) !== 0n) {
    throw new Error(`the number does not fit ${size} bytes`);
  }
  return hexToBytes(value.toString(16).padStart(2 * size, "0")).reverse();
}

/** A length as the chain's own encoding writes it before a list of bytes. */
function compactLength(length: number): Uint8Array {
  if (length < 1 << 6) return Uint8Array.of(length << 2);
  if (length < 1 << 14) return littleEndian(BigInt((length << 2) | 1), 2);
  if (length < 1 << 30) return littleEndian((BigInt(length) << 2n) | 2n, 4);
  throw new Error("the call is too long");
}

/** The call of Hydration that takes a permit: the number of its pallet and its own number. */
const DISPATCH_PERMIT = Uint8Array.of(203, 4);

/** An extrinsic of version 5 that no account signs. */
const UNSIGNED = 0x05;

/** The bytes that submit `permit` with its `signature` to Hydration. No account signs them, and
 *  any node takes them. */
export function permitExtrinsic(permit: HydrationPermit, signature: PermitSignature): Uint8Array {
  if (signature.r.length !== 32 || signature.s.length !== 32) {
    throw new Error("the two parts of the signature are 32 bytes each");
  }
  const body = concatBytes(
    Uint8Array.of(UNSIGNED),
    DISPATCH_PERMIT,
    addressBytes(permit.from),
    addressBytes(DISPATCH),
    littleEndian(0n, 32),
    compactLength(permit.call.length),
    permit.call,
    littleEndian(permit.gasLimit, 8),
    littleEndian(permit.deadline, 32),
    Uint8Array.of(signature.v),
    signature.r,
    signature.s,
  );
  return concatBytes(compactLength(body.length), body);
}

/** The account of Hydration that an Ethereum address controls, as 0x and 64 hex digits: the
 *  letters ETH, a zero byte, the address, and eight zero bytes. */
export function hydrationAccountOf(address: string): string {
  const account = concatBytes(
    utf8ToBytes("ETH"),
    new Uint8Array(1),
    addressBytes(address),
    new Uint8Array(8),
  );
  return `0x${bytesToHex(account)}`;
}
