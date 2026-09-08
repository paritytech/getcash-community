// The frozen Chainflip source catalog: 13 sources, ids locked in core's SourceId. Availability
// is gated at runtime per source by probeLiquidity.

import { sha256 } from "@noble/hashes/sha2.js";
import type { SourceDescriptor, SourceId } from "@getsome/core";

function validateBtcRefundAddress(addr: string): boolean {
  const trimmed = addr.trim();
  return (
    trimmed.length >= 26 && trimmed.length <= 90 && /^(bc1|[13])[a-zA-HJ-NP-Z0-9]+$/.test(trimmed)
  );
}

// Shape-only: 0x + 40 hex. The checksum is not enforced.
function validateEvmRefundAddress(addr: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(addr.trim());
}

function validateSolanaAddress(addr: string): boolean {
  // base58, 32-44 chars
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr.trim());
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** base58 -> bytes; null on a non-alphabet character. */
function base58Decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const c of s) {
    const i = BASE58_ALPHABET.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

/**
 * Tron addresses are base58check: 25 raw bytes = 0x41, a 20-byte payload and a 4-byte
 * sha256(sha256(first 21)) checksum, rendering as 'T' + 33 chars. The checksum is verified.
 */
function validateTronRefundAddress(addr: string): boolean {
  const trimmed = addr.trim();
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(trimmed)) return false;
  const raw = base58Decode(trimmed);
  if (raw === null || raw.length !== 25 || raw[0] !== 0x41) return false;
  const expected = sha256(sha256(raw.slice(0, 21))).slice(0, 4);
  return raw.slice(21).every((b, i) => b === expected[i]);
}

/** Exact base-units -> decimal string, no rounding. */
function formatBaseUnits(baseUnits: string | bigint, decimals: number): string {
  const value = typeof baseUnits === "string" ? BigInt(baseUnits) : baseUnits;
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fractional = value % divisor;
  if (fractional === 0n) return whole.toString();
  const fractionalStr = fractional.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fractionalStr}`;
}

/**
 * Formats an asset amount in base units as a decimal string, trimming trailing zeros.
 * `maxDecimals` caps fractional digits and rounds up.
 */
export function formatSourceAmount(
  source: { decimals: number },
  baseUnits: string | bigint,
  options?: { maxDecimals?: number },
): string {
  const decimals = Math.min(options?.maxDecimals ?? source.decimals, source.decimals);
  const ceilScale = 10n ** BigInt(source.decimals - decimals);
  const scaled = (BigInt(baseUnits) + ceilScale - 1n) / ceilScale;
  const divisor = 10n ** BigInt(decimals);
  const whole = (scaled / divisor).toString();
  const frac = (scaled % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

type UriBuilder = (
  depositAddress: string,
  asset: string,
  amountBaseUnits: string | bigint,
  decimals: number,
) => string;

const CHAIN_URI_BUILDERS: Record<string, UriBuilder> = {
  Bitcoin: (addr, _asset, amount, decimals) =>
    `bitcoin:${addr}?amount=${formatBaseUnits(amount, decimals)}`,
  Ethereum: (addr, asset, amount) => {
    // Native ETH: EIP-681 with chain id 1. ERC-20 tokens: bare address.
    if (asset === "ETH") return `ethereum:${addr}@1?value=${amount.toString()}`;
    return addr;
  },
  Arbitrum: (addr, asset, amount) => {
    if (asset === "ETH") return `ethereum:${addr}@42161?value=${amount.toString()}`;
    return addr;
  },
  Solana: (addr, asset, amount, decimals) => {
    // Native SOL: Solana Pay. SPL tokens: bare address.
    if (asset === "SOL") return `solana:${addr}?amount=${formatBaseUnits(amount, decimals)}`;
    return addr;
  },
  // Every Tron entry (native TRX and TRC-20) gets a bare address.
  Tron: (addr) => addr,
};

export interface SourceConfig extends SourceDescriptor {
  /** Asset short ticker for display. */
  readonly shortName: string;
  /**
   * Reference amount in base units, roughly $250, used by computeQuote to establish the rate
   * before quoting the precise target.
   */
  readonly referenceAmountBaseUnits: string;
  /** Validate a user-entered refund address for this source's chain. */
  validateRefundAddress(addr: string): boolean;
  /** Build the QR-encoded deposit URI for this source. */
  buildDepositUri(depositAddress: string, amountBaseUnits: string | bigint): string;
}

function makeSource(
  sourceId: SourceId,
  chain: string,
  asset: string,
  displayName: string,
  decimals: number,
  referenceAmountBaseUnits: string,
  validateRefundAddress: (addr: string) => boolean,
): SourceConfig {
  const buildUri = CHAIN_URI_BUILDERS[chain];
  if (!buildUri) throw new Error(`No deposit-URI builder for chain ${chain}`);
  return Object.freeze({
    sourceId,
    chain,
    asset,
    displayName,
    shortName: asset,
    decimals,
    referenceAmountBaseUnits,
    validateRefundAddress,
    buildDepositUri: (addr: string, amount: string | bigint) =>
      buildUri(addr, asset, amount, decimals),
  });
}

/**
 * Ordered BTC, ETH, then L2s/alt-L1s; within each chain the native asset first, stables next,
 * long-tail last.
 */
export const SOURCE_CONFIGS: readonly SourceConfig[] = Object.freeze([
  makeSource("btc", "Bitcoin", "BTC", "Bitcoin", 8, "250000", validateBtcRefundAddress),
  makeSource(
    "eth",
    "Ethereum",
    "ETH",
    "Ethereum",
    18,
    "110000000000000000",
    validateEvmRefundAddress,
  ),
  makeSource("usdc-eth", "Ethereum", "USDC", "USD Coin", 6, "250000000", validateEvmRefundAddress),
  makeSource(
    "usdt-eth",
    "Ethereum",
    "USDT",
    "Tether USD",
    6,
    "250000000",
    validateEvmRefundAddress,
  ),
  makeSource(
    "flip-ethereum",
    "Ethereum",
    "FLIP",
    "Chainflip",
    18,
    "1200000000000000000000",
    validateEvmRefundAddress,
  ),
  makeSource(
    "eth-arbitrum",
    "Arbitrum",
    "ETH",
    "Ethereum",
    18,
    "110000000000000000",
    validateEvmRefundAddress,
  ),
  makeSource(
    "usdc-arbitrum",
    "Arbitrum",
    "USDC",
    "USD Coin",
    6,
    "250000000",
    validateEvmRefundAddress,
  ),
  makeSource(
    "usdt-arbitrum",
    "Arbitrum",
    "USDT",
    "Tether USD",
    6,
    "250000000",
    validateEvmRefundAddress,
  ),
  makeSource("sol-solana", "Solana", "SOL", "Solana", 9, "3000000000", validateSolanaAddress),
  makeSource("usdc-solana", "Solana", "USDC", "USD Coin", 6, "250000000", validateSolanaAddress),
  makeSource("usdt-solana", "Solana", "USDT", "Tether USD", 6, "250000000", validateSolanaAddress),
  makeSource("trx-tron", "Tron", "TRX", "Tron", 6, "1000000000", validateTronRefundAddress),
  makeSource("usdt-tron", "Tron", "USDT", "Tether USD", 6, "250000000", validateTronRefundAddress),
]);

export const SOURCE_CONFIG_BY_ID: ReadonlyMap<SourceId, SourceConfig> = new Map(
  SOURCE_CONFIGS.map((s) => [s.sourceId, s]),
);

/** The core-typed catalog view, without validators or URI builders. */
export const SOURCES: readonly SourceDescriptor[] = SOURCE_CONFIGS.map(
  ({ sourceId, chain, asset, displayName, decimals }) =>
    Object.freeze({ sourceId, chain, asset, displayName, decimals }),
);
