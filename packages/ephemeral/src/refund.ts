// Refund keys on Chainflip's source chains: a 32-byte seed in, the address Chainflip refunds to
// and a wallet-importable secret out. secp256k1 serves Bitcoin, the EVM chains and Tron;
// ed25519 serves Solana.

import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { base58, bech32, createBase58check } from "@scure/base";

const REFUND_CHAINS = ["Bitcoin", "Ethereum", "Arbitrum", "Tron", "Solana"] as const;

export type RefundChain = (typeof REFUND_CHAINS)[number];

export function isRefundChain(chain: string): chain is RefundChain {
  return (REFUND_CHAINS as readonly string[]).includes(chain);
}

export type BitcoinNetwork = "mainnet" | "testnet";

export interface RefundKey {
  readonly chain: RefundChain;
  readonly address: string;
  /** Wallet import string: WIF (Bitcoin), 0x hex (EVM), hex (Tron), base58 64 bytes (Solana). */
  readonly secret: string;
  readonly format: "wif" | "hex" | "base58";
}

const base58check = createBase58check(sha256);

export function deriveRefundKey(
  chain: RefundChain,
  seed: Uint8Array,
  opts: { bitcoinNetwork?: BitcoinNetwork } = {},
): RefundKey {
  if (seed.length !== 32) {
    throw new Error(`deriveRefundKey: seed must be exactly 32 bytes, got ${seed.length}`);
  }
  switch (chain) {
    case "Bitcoin":
      return bitcoin(secp256k1Secret(seed), opts.bitcoinNetwork ?? "mainnet");
    case "Ethereum":
    case "Arbitrum":
      return {
        chain,
        address: checksumAddress(evmAddressBytes(secp256k1Secret(seed))),
        secret: `0x${bytesToHex(seed)}`,
        format: "hex",
      };
    case "Tron":
      return {
        chain,
        address: base58check.encode(
          new Uint8Array([0x41, ...evmAddressBytes(secp256k1Secret(seed))]),
        ),
        secret: bytesToHex(seed),
        format: "hex",
      };
    case "Solana": {
      const publicKey = ed25519.getPublicKey(seed);
      return {
        chain,
        address: base58.encode(publicKey),
        secret: base58.encode(new Uint8Array([...seed, ...publicKey])),
        format: "base58",
      };
    }
  }
}

/** The seed is used as the scalar directly, so it must lie in the curve's valid range. */
function secp256k1Secret(seed: Uint8Array): Uint8Array {
  if (!secp256k1.utils.isValidSecretKey(seed)) {
    throw new Error("deriveRefundKey: seed is not a valid secp256k1 secret key");
  }
  return seed;
}

function bitcoin(secret: Uint8Array, network: BitcoinNetwork): RefundKey {
  const hash160 = ripemd160(sha256(secp256k1.getPublicKey(secret, true)));
  const mainnet = network === "mainnet";
  return {
    chain: "Bitcoin",
    address: bech32.encode(mainnet ? "bc" : "tb", [0, ...bech32.toWords(hash160)]),
    secret: base58check.encode(new Uint8Array([mainnet ? 0x80 : 0xef, ...secret, 0x01])),
    format: "wif",
  };
}

function evmAddressBytes(secret: Uint8Array): Uint8Array {
  return keccak_256(secp256k1.getPublicKey(secret, false).subarray(1)).subarray(12);
}

/** EIP-55 mixed-case checksum. */
function checksumAddress(bytes: Uint8Array): string {
  const lower = bytesToHex(bytes);
  const hash = bytesToHex(keccak_256(utf8ToBytes(lower)));
  let out = "0x";
  for (let i = 0; i < lower.length; i++) {
    const c = lower[i]!;
    out += parseInt(hash[i]!, 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}
