import { getAddress, isAddress, type Address } from "viem";

export type Config = {
  ethereumRpcUrl: string;
  assetHubWs: string;
  router: Address;
  pool: Address;
  token: Address;
  payerSeed: string;
  confirmations: number;
  frontFeeBps: number;
  maxPerDeposit: bigint;
  maxOutstanding: bigint;
  startBlock: bigint | undefined;
  pollIntervalMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  failedRetryMs: number;
  submitTimeoutMs: number;
  unsettledAlertMinutes: number;
  stateFile: string;
  httpHost: string;
  httpPort: number;
};

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env): Config {
  return {
    ethereumRpcUrl: env.ETHEREUM_RPC_URL ?? "http://127.0.0.1:8545",
    assetHubWs: env.ASSET_HUB_WS ?? "ws://127.0.0.1:12144",
    router: address(need(env, "ROUTER_ADDRESS"), "ROUTER_ADDRESS"),
    pool: address(need(env, "POOL_ADDRESS"), "POOL_ADDRESS"),
    token: address(need(env, "TOKEN_ADDRESS"), "TOKEN_ADDRESS"),
    payerSeed: need(env, "PAYER_SEED"),
    confirmations: integer(env, "CONFIRMATIONS", 2),
    frontFeeBps: integer(env, "FRONT_FEE_BPS", 10),
    maxPerDeposit: amount(env, "MAX_PER_DEPOSIT"),
    maxOutstanding: amount(env, "MAX_OUTSTANDING"),
    startBlock: env.START_BLOCK ? BigInt(integer(env, "START_BLOCK", 0)) : undefined,
    pollIntervalMs: integer(env, "POLL_INTERVAL_MS", 1_000),
    maxAttempts: integer(env, "MAX_ATTEMPTS", 3),
    retryDelayMs: integer(env, "RETRY_DELAY_MS", 5_000),
    failedRetryMs: integer(env, "FAILED_RETRY_MS", 60_000),
    submitTimeoutMs: integer(env, "SUBMIT_TIMEOUT_MS", 60_000),
    unsettledAlertMinutes: integer(env, "UNSETTLED_ALERT_MINUTES", 30),
    stateFile: env.STATE_FILE ?? "data/payout-state.json",
    httpHost: env.HTTP_HOST ?? "127.0.0.1",
    httpPort: integer(env, "HTTP_PORT", 8788),
  };
}

// The variables the payout service takes from its env file; the trigger key and anything else in a shared file stay out of the process.
export const PAYOUT_ENV_KEYS = [
  "ETHEREUM_RPC_URL",
  "ASSET_HUB_WS",
  "ROUTER_ADDRESS",
  "POOL_ADDRESS",
  "TOKEN_ADDRESS",
  "PAYER_SEED",
  "CONFIRMATIONS",
  "FRONT_FEE_BPS",
  "MAX_PER_DEPOSIT",
  "MAX_OUTSTANDING",
  "START_BLOCK",
  "POLL_INTERVAL_MS",
  "MAX_ATTEMPTS",
  "RETRY_DELAY_MS",
  "FAILED_RETRY_MS",
  "SUBMIT_TIMEOUT_MS",
  "UNSETTLED_ALERT_MINUTES",
  "STATE_FILE",
  "HTTP_HOST",
  "HTTP_PORT",
] as const;

// The payer seed is left out on purpose, and the URLs are cut to their origin because providers put API keys in the path.
export function describeConfig(config: Config) {
  const { payerSeed: _omitted, ethereumRpcUrl, assetHubWs, maxPerDeposit, maxOutstanding, startBlock, ...rest } = config;
  return {
    ...rest,
    ethereumRpcUrl: new URL(ethereumRpcUrl).origin,
    assetHubWs: new URL(assetHubWs).origin,
    maxPerDeposit: maxPerDeposit.toString(),
    maxOutstanding: maxOutstanding.toString(),
    startBlock: startBlock?.toString(),
  };
}

function need(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function address(value: string, name: string): Address {
  if (!isAddress(value)) throw new Error(`${name} is not an address: ${value}`);
  return getAddress(value);
}

function amount(env: Env, name: string): bigint {
  const raw = need(env, name);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer in token base units`);
  return BigInt(raw);
}

function integer(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}
