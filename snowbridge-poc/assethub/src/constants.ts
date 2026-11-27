import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const ASSET_HUB_WS = "ws://127.0.0.1:12144";
export const BRIDGE_HUB_WS = "ws://127.0.0.1:11144";

export const ETHEREUM_CHAIN_ID = 11155111n;
export const BRIDGE_HUB_PARA_ID = 1002;
export const INBOUND_QUEUE_V2_PALLET = 91;

/** `settle` measured 1.07e9 / 51.9k paying everyone and 1.50e9 / 83.1k with both payouts owed (local runtime). */
export const DEFAULT_SETTLE_WEIGHT = { refTime: 2_500_000_000n, proofSize: 150_000n };
/** A new storage slot costs 132_000_000 planck of deposit, charged to the router's account. */
export const DEFAULT_STORAGE_DEPOSIT_LIMIT = 10_000_000_000n;

/** Fixed address of the XCM precompile in pallet-revive. */
export const XCM_PRECOMPILE = "0x00000000000000000000000000000000000a0000";
/** Suffix of the foreign-assets ERC-20 precompile addresses; the asset index fills the first four bytes. */
export const FOREIGN_ASSETS_PRECOMPILE_SUFFIX = "02200000";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEPLOYMENT_FILE = resolve(ROOT, "deployments/local.json");
export const BUILD_DIR = resolve(ROOT, "build");

/** Snowbridge's stack output directory; setup.sh exports it, and Snowbridge's own scripts read the same variable. */
export const OUTPUT_DIR = process.env.OUTPUT_DIR ?? "/tmp/snowbridge-v2";
export const CONTRACTS_JSON = resolve(OUTPUT_DIR, "contracts.json");
/** The Snowbridge checkout the stack runs from; setup.sh exports it, the default is where setup.sh clones it. */
export const SNOWBRIDGE_DIR = process.env.SNOWBRIDGE_DIR ?? resolve(process.env.GC_E2E_WORK ?? resolve(ROOT, "../.work"), "snowbridge");
