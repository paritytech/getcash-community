import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";

const UINT128_MAX = (1n << 128n) - 1n;

export type MinAmounts = { all?: bigint; perToken: Record<string, bigint> };

export type Config = {
  rpcUrl: string;
  assetHubWs: string;
  factory: Address;
  tokens: Address[];
  minTriggerAmount: MinAmounts;
  executionFee: bigint;
  executionFeeMarginMilli: bigint;
  relayerFee: bigint;
  pollIntervalMs: number;
  maxBackoffMs: number;
  receiptTimeoutMs: number;
  quoteIntervalMs: number;
  quoteMaxAgeMs: number;
  quoteTimeoutMs: number;
  triggerKey: Hex;
  stateFile: string;
  httpHost: string;
  httpPort: number;
};

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env): Config {
  const tokens = tokenList(need(env, "TOKEN_ALLOWLIST"));
  return {
    rpcUrl: need(env, "RPC_URL"),
    assetHubWs: env.ASSET_HUB_WS || "ws://127.0.0.1:12144",
    factory: address(need(env, "FACTORY_ADDRESS"), "FACTORY_ADDRESS"),
    tokens,
    minTriggerAmount: minAmounts(env.MIN_TRIGGER_AMOUNT, tokens),
    executionFee: fee(env, "EXECUTION_FEE_WEI", undefined),
    executionFeeMarginMilli: margin(env.EXECUTION_FEE_MARGIN),
    relayerFee: fee(env, "RELAYER_FEE_WEI", 0n),
    pollIntervalMs: integer(env, "POLL_INTERVAL_MS", 3_000),
    maxBackoffMs: integer(env, "MAX_BACKOFF_MS", 60_000),
    receiptTimeoutMs: integer(env, "RECEIPT_TIMEOUT_MS", 120_000),
    quoteIntervalMs: integer(env, "QUOTE_INTERVAL_MS", 60_000),
    quoteMaxAgeMs: integer(env, "QUOTE_MAX_AGE_MS", 300_000),
    quoteTimeoutMs: integer(env, "QUOTE_TIMEOUT_MS", 15_000),
    triggerKey: parseTriggerKey(env.TRIGGER_KEY),
    stateFile: env.STATE_FILE ?? "data/trigger-state.json",
    httpHost: env.HTTP_HOST ?? "127.0.0.1",
    httpPort: integer(env, "HTTP_PORT", 8787),
  };
}

export function parseTriggerKey(value: string | undefined): Hex {
  if (!value) throw new Error("missing TRIGGER_KEY");
  if (!isHex(value, { strict: true }) || value.length !== 66) throw new Error("TRIGGER_KEY must be 0x followed by 64 hex digits");
  return value;
}

// The variables the trigger service takes from its env file; anything else in a shared file stays out of the process.
export const TRIGGER_ENV_KEYS = [
  "RPC_URL",
  "ASSET_HUB_WS",
  "FACTORY_ADDRESS",
  "TOKEN_ALLOWLIST",
  "MIN_TRIGGER_AMOUNT",
  "EXECUTION_FEE_WEI",
  "EXECUTION_FEE_MARGIN",
  "RELAYER_FEE_WEI",
  "POLL_INTERVAL_MS",
  "MAX_BACKOFF_MS",
  "RECEIPT_TIMEOUT_MS",
  "QUOTE_INTERVAL_MS",
  "QUOTE_MAX_AGE_MS",
  "QUOTE_TIMEOUT_MS",
  "TRIGGER_KEY",
  "STATE_FILE",
  "HTTP_HOST",
  "HTTP_PORT",
] as const;

// The trigger key is left out on purpose, and URLs are cut to their origin because providers put API keys in the path.
export function describeConfig(config: Config) {
  const { triggerKey: _omitted, rpcUrl, assetHubWs, executionFee, relayerFee, minTriggerAmount, executionFeeMarginMilli, ...rest } = config;
  return {
    ...rest,
    rpcUrl: new URL(rpcUrl).origin,
    assetHubWs: new URL(assetHubWs).origin,
    executionFee: executionFee.toString(),
    executionFeeMarginMilli: executionFeeMarginMilli.toString(),
    relayerFee: relayerFee.toString(),
    minTriggerAmount: {
      all: minTriggerAmount.all?.toString(),
      perToken: Object.fromEntries(Object.entries(minTriggerAmount.perToken).map(([token, value]) => [token, value.toString()])),
    },
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

function tokenList(value: string): Address[] {
  const tokens = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => address(item, "TOKEN_ALLOWLIST entry"));
  if (tokens.length === 0) throw new Error("TOKEN_ALLOWLIST is empty");
  return [...new Set(tokens)];
}

// One integer applies to every token; `token=amount` pairs set single tokens; a token without either gets one whole token at its decimals.
function minAmounts(raw: string | undefined, tokens: Address[]): MinAmounts {
  const text = raw?.trim();
  if (!text) return { perToken: {} };
  if (/^\d+$/.test(text)) return { all: BigInt(text), perToken: {} };

  const perToken: Record<string, bigint> = {};
  for (const item of text.split(",")) {
    const [token, value, ...extra] = item.split("=").map((part) => part.trim());
    if (!token || !value || extra.length > 0 || !/^\d+$/.test(value)) throw new Error("MIN_TRIGGER_AMOUNT must be an integer or comma-separated token=amount pairs");
    const checksummed = address(token, "MIN_TRIGGER_AMOUNT token");
    if (!tokens.includes(checksummed)) throw new Error(`MIN_TRIGGER_AMOUNT names ${checksummed}, which is not in TOKEN_ALLOWLIST`);
    perToken[checksummed.toLowerCase()] = BigInt(value);
  }
  return { perToken };
}

// A decimal such as 1.2, kept in thousandths; below 1 the quote itself would not be covered.
function margin(raw: string | undefined): bigint {
  const text = raw?.trim() || "1.2";
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(text);
  if (!match) throw new Error("EXECUTION_FEE_MARGIN must be a decimal with at most three digits after the point");
  const milli = BigInt(match[1]!) * 1000n + BigInt((match[2] ?? "").padEnd(3, "0"));
  if (milli < 1000n) throw new Error("EXECUTION_FEE_MARGIN must be at least 1");
  return milli;
}

function fee(env: Env, name: string, fallback: bigint | undefined): bigint {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    if (fallback === undefined) throw new Error(`missing ${name}`);
    return fallback;
  }
  if (!/^\d+$/.test(raw) || BigInt(raw) > UINT128_MAX) throw new Error(`${name} must be an integer that fits in uint128`);
  return BigInt(raw);
}

function integer(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}
