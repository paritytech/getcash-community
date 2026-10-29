// A SaleVaultProxyFactory deployment and the CREATE2 address of a seller home and claimer's SaleVaultProxy.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { NETWORK } from "@getsome/core";
import type { ChainflipNetworkId } from "./sdk";
import saleVaultProxyVectors from "../../sale-vault-proxy/vectors.json";

/** One deployed factory and the implementation every proxy it makes delegates to. */
export interface SaleVaultProxyContracts {
  chainId: number;
  factory: string;
  implementation: string;
}

/** The deployment a build sells through, with the least a sale through it commits. */
export interface SaleVaultProxyDeployment extends SaleVaultProxyContracts {
  /** The least a sale commits, so a held or refunded sale can always go home. */
  minSale: bigint;
}

/** The Arbitrum chain id a sale's proxy lives on per Chainflip network, as the Chainflip SDK's getChains names it. */
export const SALE_VAULT_PROXY_CHAIN_IDS: Readonly<Record<ChainflipNetworkId, number>> = {
  mainnet: 42161,
  perseverance: 421614,
};

/** The Chainflip network a fiat sale swaps on, Perseverance on a test build. */
export const SALE_SWAP_NETWORK: ChainflipNetworkId = NETWORK.testnet ? "perseverance" : "mainnet";

/** The Arbitrum chain this build's sale proxies live on. */
export const SALE_VAULT_PROXY_CHAIN_ID: number = SALE_VAULT_PROXY_CHAIN_IDS[SALE_SWAP_NETWORK];

/** The CCM gas budget a sale's channel carries, enough for the factory to deploy a proxy and pay. */
export const SALE_VAULT_PROXY_CCM_GAS_BUDGET: string = saleVaultProxyVectors.gas.CCM_GAS_BUDGET;

// The USDC token's EIP-712 name and version, as name() and version() answer on both Arbitrum networks
const USDC_DOMAIN_NAME = "USD Coin";
const USDC_DOMAIN_VERSION = "2";

interface NetworkVectors {
  usdc: string;
  minSale: string;
  releaseDelay: string;
  staleDelay: string;
}

// A proxy network's terms, as packages/sale-vault-proxy's networks config writes them
const networkVectors = (chainId: number): NetworkVectors | undefined =>
  (saleVaultProxyVectors.networks as Record<string, NetworkVectors | undefined>)[String(chainId)];

/** The least a sale through a proxy on `chainId` commits, so a held or refunded sale can always go home, null on a chain with no vectors. */
export function saleVaultProxyMinSale(chainId: number): bigint | null {
  const network = networkVectors(chainId);
  return network === undefined ? null : BigInt(network.minSale);
}

// A whole positive count of seconds in ms, so a pruned vectors entry fails loud instead of timing on NaN
const secondsMs = (value: string, name: string): number => {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds <= 0)
    throw new Error(
      `sale-vault-proxy vectors: ${name} is ${String(value)}, not a positive whole second count`,
    );
  return seconds * 1000;
};

/** A proxy's release clocks on `chainId` in ms, as its factory's immutables hold them, null on a chain with no vectors. */
export function saleVaultProxyDelaysMs(
  chainId: number,
): { releaseDelayMs: number; staleDelayMs: number } | null {
  const network = networkVectors(chainId);
  if (network === undefined) return null;
  return {
    releaseDelayMs: secondsMs(network.releaseDelay, "releaseDelay"),
    staleDelayMs: secondsMs(network.staleDelay, "staleDelay"),
  };
}

/** The EIP-712 domain of the USDC a proxy on `chainId` holds, null on a chain with no vectors. */
export function saleVaultProxyUsdcDomain(chainId: number): {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
} | null {
  const network = networkVectors(chainId);
  if (network === undefined) return null;
  return {
    name: USDC_DOMAIN_NAME,
    version: USDC_DOMAIN_VERSION,
    chainId,
    verifyingContract: network.usdc,
  };
}

/** How long a sale's swap retries its price before Chainflip refunds the key, so a late delivery can still land. */
export const SALE_SWAP_RETRY_MINUTES = 30;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HOME = /^(0x)?[0-9a-fA-F]{64}$/;

/** The chain id and two nonzero 0x addresses raw values name, or null when any is missing or malformed. */
export function saleVaultProxyContractsOf(raw: {
  chainId?: unknown;
  factory?: unknown;
  implementation?: unknown;
}): SaleVaultProxyContracts | null {
  const [chainId, factory, implementation] = [raw.chainId, raw.factory, raw.implementation].map(
    (v) => (typeof v === "string" || typeof v === "number" ? String(v).trim() : ""),
  ) as [string, string, string];
  if (!/^[1-9][0-9]*$/.test(chainId) || !Number.isSafeInteger(Number(chainId))) return null;
  if (!ADDRESS.test(factory) || !ADDRESS.test(implementation)) return null;
  // A zero factory or implementation can never deliver a sale
  if ([factory, implementation].some((a) => /^0x0{40}$/.test(a))) return null;
  return { chainId: Number(chainId), factory, implementation };
}

// The EIP-1167 proxy code around the implementation, as OpenZeppelin writes it with immutable args
const PROXY_CODE_PREFIX = "3d81600a3d39f3363d3d373d3d3d363d73";
const PROXY_CODE_SUFFIX = "5af43d82803e903d91602b57fd5bf3";
const PROXY_CODE_BYTES = 0x2d;

// EIP-55 mixed case over the lowercase hex
function checksum(lowerHex: string): string {
  const hash = bytesToHex(keccak_256(utf8ToBytes(lowerHex)));
  let out = "0x";
  for (let i = 0; i < lowerHex.length; i++) {
    const c = lowerHex[i]!;
    out += parseInt(hash[i]!, 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

function evmAddress(value: string, what: string): string {
  if (!ADDRESS.test(value)) throw new Error(`${what} must be a 20-byte 0x address`);
  return value.slice(2).toLowerCase();
}

/** The EIP-55 address the factory deploys a home and claimer's proxy at, home || claimer as args and their keccak as salt. */
export function predictSaleVaultProxy(
  factory: string,
  implementation: string,
  homeHex: string,
  claimer: string,
): string {
  if (!HOME.test(homeHex)) throw new Error("home account must be 32 bytes");
  const owner = evmAddress(claimer, "claimer");
  // The factory refuses a zero claimer, so no proxy exists for one
  if (/^0+$/.test(owner)) throw new Error("claimer must not be the zero address");
  const args = `${homeHex.replace(/^0x/, "").toLowerCase()}${owner}`;
  const argsLength = (args.length / 2 + PROXY_CODE_BYTES).toString(16).padStart(4, "0");
  const impl = evmAddress(implementation, "implementation");
  const initCode = `61${argsLength}${PROXY_CODE_PREFIX}${impl}${PROXY_CODE_SUFFIX}${args}`;
  const initCodeHash = bytesToHex(keccak_256(hexToBytes(initCode)));
  const salt = bytesToHex(keccak_256(hexToBytes(args)));
  const preimage = `ff${evmAddress(factory, "factory")}${salt}${initCodeHash}`;
  return checksum(bytesToHex(keccak_256(hexToBytes(preimage)).subarray(12)));
}

/** Whether a value is a 20-byte 0x address. */
export const isEvmAddress = (value: unknown): value is string =>
  typeof value === "string" && ADDRESS.test(value);

/** Whether a value is an EVM address funds can be sent to: not zero, and in one case or EIP-55. */
export function isEvmPayeeAddress(value: unknown): value is string {
  if (!isEvmAddress(value)) return false;
  const digits = value.slice(2);
  if (/^0+$/.test(digits)) return false;
  return (
    digits === digits.toLowerCase() ||
    digits === digits.toUpperCase() ||
    checksum(digits.toLowerCase()) === value
  );
}

/** Whether two strings name the same EVM address, whatever their casing. */
export const sameEvmAddress = (a: string, b: string): boolean =>
  isEvmAddress(a) && isEvmAddress(b) && a.toLowerCase() === b.toLowerCase();

/** Whether a target the adapter names is exactly the deployment this build is configured with. */
export const saleVaultProxyMatches = (
  deployment: SaleVaultProxyContracts,
  target: SaleVaultProxyContracts,
): boolean =>
  target.chainId === deployment.chainId &&
  sameEvmAddress(target.factory, deployment.factory) &&
  sameEvmAddress(target.implementation, deployment.implementation);
