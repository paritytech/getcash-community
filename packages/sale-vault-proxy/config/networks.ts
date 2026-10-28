// Per-network SaleVaultProxyFactory config. The treasury and the guardian come from the environment at deploy time.

import vectors from "../vectors.json";

// Chainflip protocol ids for the return leg, as @chainflip/utils chainContractId and assetContractId name them
export const HOME_CHAIN = 6; // Assethub
export const HOME_TOKEN = 12; // HubUsdt

// Arbitrum One fork gas measurement, written by scripts/vectors.ts
export const CCM_GAS_BUDGET = BigInt(vectors.gas.CCM_GAS_BUDGET);

// Chainflip State Chain block time in seconds, its Aura slot, checked live in liveProblems
export const CF_BLOCK_SECONDS = 6n;
// Chainflip's longest swap request before it refunds, in State Chain blocks
export const CF_MAX_SWAP_REQUEST_BLOCKS = 14_400n;
// The proxy's return backoff stops doubling after this many shifts
export const MAX_BACKOFF_SHIFT = 6n;

// A killed return's refund lands within the longest swap request, 14400 blocks of 6 s
export const RELEASE_DELAY = CF_MAX_SWAP_REQUEST_BLOCKS * CF_BLOCK_SECONDS;
// The first return that waits the capped 64x backoff, past it returns are only refunding
export const RELEASE_ATTEMPTS = MAX_BACKOFF_SHIFT + 1n;
// A returnable balance goes to the claimer after 60 days, the window the adapter keeper watches a proxy for
export const STALE_DELAY = 60n * 86_400n;

// Arbitrum's NodeInterface precompile, which prices a transaction's L1 part
export const ARBITRUM_NODE_INTERFACE = "0x00000000000000000000000000000000000000C8";

// Return retry window in State Chain blocks, 10 minutes, under Chainflip's 600 block cap
export const RETRY_BLOCKS = 100;
// Least USDT per USDC a return accepts before the fee allowance, in bps
export const PRICE_FLOOR_BPS = 9900n;

export interface SaleVaultProxyNetwork {
  chainId: number;
  // Chainflip State Chain RPC, read to check this config against live limits
  chainflipRpc: string;
  // Chainflip swap backend, the cfParameters encoder and the adapter's quote source
  swapApi: string;
  vault: string;
  usdc: string;
  // A registered Chainflip broker account, checked live in liveProblems
  broker: string;
  homeChain: number;
  homeToken: number;
  // How long a return retries its min price before Chainflip refunds it
  retryBlocks: number;
  // Chainflip MinimumDeposit for Arbitrum USDC
  minDeposit: bigint;
  // Chainflip refund fee (the network fee minimum) plus the Arbitrum USDC egress fee, with headroom
  refundFee: bigint;
  // Least balance a return sends, above minDeposit plus two refund fees as the factory requires
  minReturn: bigint;
  // Most one return sends, at least twice minReturn, 0 is refused
  maxReturn: bigint;
  priceFloorBps: bigint;
  // Network fee minimum plus the Asset Hub USDT egress fee, with headroom, taken off the floor output
  feeAllowance: bigint;
  // Base wait between returns, longer than the retry window so a killed return refunds first
  returnCooldown: bigint;
  // Wait after the last activity before a balance below minReturn can go to the claimer
  releaseDelay: bigint;
  // Returns sent after which any balance can go to the claimer
  releaseAttempts: bigint;
  // Wait after the last activity before any balance can go to the claimer
  staleDelay: bigint;
  // Least sale the app offers, so a held sale stays returnable through every killed return before release
  minSale: bigint;
}

// Arbitrum One, Chainflip mainnet
export const ARBITRUM_ONE: SaleVaultProxyNetwork = {
  chainId: 42161,
  chainflipRpc: "https://rpc.mainnet.chainflip.io",
  swapApi: "https://chainflip-swap.chainflip.io",
  vault: "0x79001a5e762f3bEFC8e5871b42F6734e00498920",
  usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  broker: "0x70d0cd75a367987344a3896a18e1510e5429ca5e88357b6c2a2e306b3877380d",
  homeChain: HOME_CHAIN,
  homeToken: HOME_TOKEN,
  retryBlocks: RETRY_BLOCKS,
  minDeposit: 10_000_000n,
  refundFee: 510_000n,
  minReturn: 20_000_000n,
  maxReturn: 10_000_000_000n,
  priceFloorBps: PRICE_FLOOR_BPS,
  feeAllowance: 600_000n,
  returnCooldown: 3600n,
  releaseDelay: RELEASE_DELAY,
  releaseAttempts: RELEASE_ATTEMPTS,
  staleDelay: STALE_DELAY,
  minSale: 25_000_000n,
};

// Arbitrum Sepolia, Chainflip Perseverance
export const ARBITRUM_SEPOLIA: SaleVaultProxyNetwork = {
  chainId: 421614,
  chainflipRpc: "https://archive.perseverance.chainflip.io",
  swapApi: "https://chainflip-swap-perseverance.chainflip.io",
  vault: "0x2bb150e6d4366A1BDBC4275D1F35892CD63F27e3",
  usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
  broker: "0x9e8d88ae895c9b37b2dead9757a3452f7c2299704d91ddfa444d87723f94fe0c",
  homeChain: HOME_CHAIN,
  homeToken: HOME_TOKEN,
  retryBlocks: RETRY_BLOCKS,
  minDeposit: 0n,
  refundFee: 10_000n,
  minReturn: 1_000_000n,
  maxReturn: 100_000_000n,
  priceFloorBps: PRICE_FLOOR_BPS,
  feeAllowance: 50_000n,
  returnCooldown: 900n,
  releaseDelay: RELEASE_DELAY,
  releaseAttempts: RELEASE_ATTEMPTS,
  staleDelay: STALE_DELAY,
  minSale: 1_250_000n,
};

// The constructor Config tuple for a network, treasury and guardian
export function factoryConfig(net: SaleVaultProxyNetwork, treasury: string, guardian: string) {
  return {
    vault: net.vault,
    usdc: net.usdc,
    treasury,
    guardian,
    broker: net.broker,
    homeChain: net.homeChain,
    homeToken: net.homeToken,
    retryBlocks: net.retryBlocks,
    minDeposit: net.minDeposit,
    refundFee: net.refundFee,
    minReturn: net.minReturn,
    maxReturn: net.maxReturn,
    priceFloorBps: net.priceFloorBps,
    feeAllowance: net.feeAllowance,
    returnCooldown: net.returnCooldown,
    releaseDelay: net.releaseDelay,
    releaseAttempts: net.releaseAttempts,
    staleDelay: net.staleDelay,
  };
}

// A network's vectors.json entry, the app reads usdc, minSale, releaseDelay and staleDelay, the adapter tests copy the rest
export function networkVectors(net: SaleVaultProxyNetwork) {
  return {
    vault: net.vault,
    usdc: net.usdc,
    broker: net.broker,
    minDeposit: net.minDeposit.toString(),
    refundFee: net.refundFee.toString(),
    minReturn: net.minReturn.toString(),
    maxReturn: net.maxReturn.toString(),
    returnCooldown: net.returnCooldown.toString(),
    releaseDelay: net.releaseDelay.toString(),
    releaseAttempts: net.releaseAttempts.toString(),
    staleDelay: net.staleDelay.toString(),
    minSale: net.minSale.toString(),
  };
}

// The adapter's sale_vault_proxy fields deploy can fill, the operator adds rpc_url and keeper_key
export function adapterSaleVaultProxy(net: SaleVaultProxyNetwork, factory: string) {
  return {
    chain_id: net.chainId,
    factory: factory.toLowerCase(),
    chainflip_vault: net.vault.toLowerCase(),
    usdc: net.usdc.toLowerCase(),
    chainflip: { rpc_url: net.chainflipRpc },
  };
}
