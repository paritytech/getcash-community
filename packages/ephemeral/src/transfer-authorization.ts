// An EIP-3009 transferWithAuthorization signed by an EVM refund key, so a relayer pays its gas.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

/** The EIP-712 domain a token signs its authorizations under. */
interface Eip712Domain {
  readonly name: string;
  readonly version: string;
  readonly chainId: number;
  readonly verifyingContract: string;
}

/** One transfer as the holder authorizes it, the window in unix seconds. */
export interface TransferAuthorization {
  readonly from: string;
  readonly to: string;
  readonly value: bigint;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  /** 32 bytes of 0x hex, any the holder has not used. */
  readonly nonce: string;
}

const DOMAIN_TYPE =
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
/** The struct FiatTokenV2 hashes for `transferWithAuthorization`. */
const TRANSFER_WITH_AUTHORIZATION_TYPE =
  "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const MAX_UINT256 = (1n << 256n) - 1n;

const keccakText = (text: string): Uint8Array => keccak_256(utf8ToBytes(text));

function word(value: bigint): Uint8Array {
  if (value < 0n || value > MAX_UINT256) throw new Error("value must fit a uint256");
  return hexToBytes(value.toString(16).padStart(64, "0"));
}

function addressWord(value: string, what: string): Uint8Array {
  if (!ADDRESS.test(value)) throw new Error(`${what} must be a 20-byte 0x address`);
  return hexToBytes(value.slice(2).toLowerCase().padStart(64, "0"));
}

/** The domain separator a token derives from its domain, as `DOMAIN_SEPARATOR()` answers it. */
export function eip712DomainSeparator(domain: Eip712Domain): Uint8Array {
  return keccak_256(
    concatBytes(
      keccakText(DOMAIN_TYPE),
      keccakText(domain.name),
      keccakText(domain.version),
      word(BigInt(domain.chainId)),
      addressWord(domain.verifyingContract, "verifyingContract"),
    ),
  );
}

/** The digest the token recovers the holder from, `\x19\x01 || domainSeparator || structHash`. */
export function transferAuthorizationDigest(
  domain: Eip712Domain,
  a: TransferAuthorization,
): Uint8Array {
  if (!BYTES32.test(a.nonce)) throw new Error("nonce must be 32 bytes of 0x hex");
  const structHash = keccak_256(
    concatBytes(
      keccakText(TRANSFER_WITH_AUTHORIZATION_TYPE),
      addressWord(a.from, "from"),
      addressWord(a.to, "to"),
      word(a.value),
      word(a.validAfter),
      word(a.validBefore),
      hexToBytes(a.nonce.slice(2)),
    ),
  );
  return keccak_256(
    concatBytes(Uint8Array.of(0x19, 0x01), eip712DomainSeparator(domain), structHash),
  );
}

/** The 65-byte `r || s || v` signature, low s and v 27 or 28 as the token's ECRecover requires. */
export function signTransferAuthorization(
  secret: Uint8Array,
  domain: Eip712Domain,
  a: TransferAuthorization,
): string {
  const recovered = secp256k1.sign(transferAuthorizationDigest(domain, a), secret, {
    prehash: false,
    format: "recovered",
  });
  const recovery = recovered[0]!;
  // Recovery ids 2 and 3 have no v the token accepts
  if (recovery > 1) throw new Error("the signature has no recovery id the token accepts");
  return `0x${bytesToHex(recovered.subarray(1))}${(27 + recovery).toString(16)}`;
}
