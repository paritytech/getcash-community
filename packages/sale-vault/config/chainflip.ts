// Verified Chainflip + Arbitrum constants for deploying and testing SaleVault.
//
// Sources (verified 2026-10-13):
// - Arbitrum Vault + USDC: https://docs.chainflip.io/protocol/supported-chains-assets/mainnet-addresses
//   (Vault also matches getcash packages/chainflip/src/sources.ts).
// - Chainflip chain/asset ids: @chainflip/utils 2.2.0 (the version getcash resolves).
// - Arbitrum Sepolia Vault/USDC are the testnet (Perseverance) values from the plan and MUST be
//   reconfirmed against Chainflip's testnet addresses before the Sepolia deploy.

export const ARBITRUM_ONE = {
  chainflipVault: "0x79001a5e762f3bEFC8e5871b42F6734e00498920",
  usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
} as const;

// Arbitrum Sepolia (Perseverance testnet) Chainflip Vault and USDC.
export const ARBITRUM_SEPOLIA = {
  chainflipVault: "0x2bb150e6d4366A1BDBC4275D1F35892CD63F27e3",
  usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
} as const;

// Chainflip protocol ids for the return leg (USDT on Polkadot Asset Hub).
export const HOME_CHAIN = 6; // Assethub
export const HOME_TOKEN = 12; // HubUsdt
