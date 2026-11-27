import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ETHEREUM_RPC = "http://127.0.0.1:8545";
export const ASSET_HUB_WS = "ws://127.0.0.1:12144";

export const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = resolve(E2E_DIR, "..");
export const ETH_DIR = resolve(REPO_DIR, "eth");
export const ASSETHUB_DIR = resolve(REPO_DIR, "assethub");
export const SERVICES_DIR = resolve(REPO_DIR, "services");

export const ENV_LOCAL = resolve(E2E_DIR, ".env.local");
export const DEPLOYMENT_FILE = resolve(E2E_DIR, "deployments/local.json");
export const ASSETHUB_DEPLOYMENT_FILE = resolve(ASSETHUB_DIR, "deployments/local.json");
export const POOL_ARTIFACT = resolve(ASSETHUB_DIR, "build/Pool.json");

const ONE_TOKEN = 10n ** 18n;
const ONE_WND = 10n ** 12n;

export const DEFAULTS = {
  bridgeFee: ONE_TOKEN / 1000n,
  frontFeeCapBps: 100,
  ethFunding: { admin: 10n * 10n ** 18n, trigger: 10n * 10n ** 18n, guardian: 10n ** 18n },
  wndFunding: { router: 10n * ONE_WND, payer: 100n * ONE_WND, feeAccount: ONE_WND },
  payerPoolFunds: 500n * ONE_TOKEN,
  executionFeeMarginPercent: 150n,
};
