// Funding + dispatch constants for the Revive spend path.

/** EVM values are 18-dec, chain plancks are 10-dec: scale /10^8 at the Revive boundary. */
export const EVM_CHAIN_DECIMAL_DIFF = 8n;

/** 0.2 DOT storage-deposit limit for every Revive.call; refundable, swept back. */
export const REVIVE_STORAGE_DEPOSIT = 2_000_000_000n;

/** 0.01 DOT Asset Hub existential deposit. */
export const EXISTENTIAL_DEPOSIT = 100_000_000n;

/** Conservative weights when the action gives no weightHint. */
export const DEFAULT_WEIGHT = { refTime: 4_500_000_000n, proofSize: 1_000_000n } as const;

/** 3% slippage tolerance on the Tier-2 AssetConversion swap. */
export const SWAP_SLIPPAGE_BPS = 300n;

// Asset Hub sufficient-stable asset ids (hubUSDC = GeneralIndex 1337).
export const USDC_ASSET_ID = 1337;
export const USDT_ASSET_ID = 1984;
