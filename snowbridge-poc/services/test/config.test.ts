import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeError } from "../src/common/errors";
import { loadScopedEnvFile } from "../src/common/env";
import { loadConfig as loadPayoutConfig, PAYOUT_ENV_KEYS } from "../src/payout/config";
import { describeConfig, loadConfig, TRIGGER_ENV_KEYS } from "../src/trigger/config";
import { readTriggerKey } from "../src/trigger/key";
import { loadUserEnv, USER_ENV_KEYS } from "../src/user/env";
import { BaseError, HttpRequestError } from "viem";
import { envNamesRead } from "./helpers/env";

const TOKEN = "0x54d6643762e46036b3448659791adaf554225541";
const OTHER = "0x2222222222222222222222222222222222222222";
const KEY = `0x${"0a".repeat(32)}`;

const triggerEnv = {
  RPC_URL: "http://127.0.0.1:8545",
  FACTORY_ADDRESS: "0x1111111111111111111111111111111111111111",
  TOKEN_ALLOWLIST: TOKEN,
  EXECUTION_FEE_WEI: "500000000000000",
  TRIGGER_KEY: KEY,
};

const payoutEnv = {
  ROUTER_ADDRESS: "0x1111111111111111111111111111111111111111",
  POOL_ADDRESS: "0x2222222222222222222222222222222222222222",
  TOKEN_ADDRESS: TOKEN,
  PAYER_SEED: `0x${"07".repeat(32)}`,
  MAX_PER_DEPOSIT: "1000",
  MAX_OUTSTANDING: "5000",
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "env-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("trigger config", () => {
  it("defaults the minimum to one token per decimals, the margin to 1.2 and Asset Hub to the local stack", () => {
    expect(loadConfig(triggerEnv)).toMatchObject({
      assetHubWs: "ws://127.0.0.1:12144",
      minTriggerAmount: { perToken: {} },
      executionFeeMarginMilli: 1200n,
      quoteIntervalMs: 60_000,
      quoteMaxAgeMs: 300_000,
      quoteTimeoutMs: 15_000,
    });
  });

  it("reads MIN_TRIGGER_AMOUNT as one integer for every token or as token=amount pairs, and rejects the rest", () => {
    expect(loadConfig({ ...triggerEnv, MIN_TRIGGER_AMOUNT: "2500000" }).minTriggerAmount).toEqual({ all: 2_500_000n, perToken: {} });
    expect(loadConfig({ ...triggerEnv, MIN_TRIGGER_AMOUNT: `${TOKEN}=42` }).minTriggerAmount).toEqual({ perToken: { [TOKEN]: 42n } });
    expect(() => loadConfig({ ...triggerEnv, MIN_TRIGGER_AMOUNT: `${OTHER}=42` })).toThrow("not in TOKEN_ALLOWLIST");
    expect(() => loadConfig({ ...triggerEnv, MIN_TRIGGER_AMOUNT: "1e6" })).toThrow("MIN_TRIGGER_AMOUNT");
    expect(() => loadConfig({ ...triggerEnv, MIN_TRIGGER_AMOUNT: `${TOKEN}=` })).toThrow("MIN_TRIGGER_AMOUNT");
  });

  it("reads EXECUTION_FEE_MARGIN in thousandths and refuses a margin below 1", () => {
    expect(loadConfig({ ...triggerEnv, EXECUTION_FEE_MARGIN: "1.05" }).executionFeeMarginMilli).toBe(1050n);
    expect(loadConfig({ ...triggerEnv, EXECUTION_FEE_MARGIN: "2" }).executionFeeMarginMilli).toBe(2000n);
    expect(() => loadConfig({ ...triggerEnv, EXECUTION_FEE_MARGIN: "0.9" })).toThrow("at least 1");
    expect(() => loadConfig({ ...triggerEnv, EXECUTION_FEE_MARGIN: "1.2345" })).toThrow("EXECUTION_FEE_MARGIN");
    expect(() => loadConfig({ ...triggerEnv, EXECUTION_FEE_MARGIN: "lots" })).toThrow("EXECUTION_FEE_MARGIN");
  });

  it("keeps the trigger key and URL paths out of the description", () => {
    const described = JSON.stringify(describeConfig(loadConfig({ ...triggerEnv, ASSET_HUB_WS: "wss://ah.example/key-in-path", RPC_URL: "https://rpc.example/v3/secret" })));

    expect(described).not.toContain(KEY.slice(2));
    expect(described).not.toContain("key-in-path");
    expect(described).not.toContain("secret");
  });

  it("lists exactly the variables the config reads, so a new one cannot be left out of the env file scope", () => {
    expect(new Set(envNamesRead(loadConfig, triggerEnv))).toEqual(new Set(TRIGGER_ENV_KEYS));
    expect(new Set(envNamesRead(loadPayoutConfig, payoutEnv))).toEqual(new Set(PAYOUT_ENV_KEYS));
  });
});

describe("env files", () => {
  it("applies only the named keys and lets variables that are already set win", () => {
    const file = join(dir, ".env");
    writeFileSync(file, "RPC_URL=http://file\nTRIGGER_KEY=0xsecret\nPAYER_SEED=seed\nHTTP_PORT=1\n");
    const env: Record<string, string | undefined> = { HTTP_PORT: "9" };

    expect(loadScopedEnvFile(file, ["RPC_URL", "HTTP_PORT"], env)).toBe(true);

    expect(env).toEqual({ RPC_URL: "http://file", HTTP_PORT: "9" });
    expect(loadScopedEnvFile(join(dir, "missing"), ["RPC_URL"], {})).toBe(false);
  });

  it("keeps the trigger key out of the payout service's variables and the payout seed out of the trigger's", () => {
    expect(PAYOUT_ENV_KEYS).not.toContain("TRIGGER_KEY");
    expect(PAYOUT_ENV_KEYS).not.toContain("USER_SEED");
    expect(TRIGGER_ENV_KEYS).not.toContain("PAYER_SEED");
    expect(USER_ENV_KEYS).not.toContain("TRIGGER_KEY");
  });

  it("reads the trigger key from the env file first, empties the process variable, and fails when there is none", () => {
    const file = join(dir, ".env");
    const other = `0x${"0b".repeat(32)}`;
    writeFileSync(file, `TRIGGER_KEY=${other}\n`);
    const env: Record<string, string | undefined> = { TRIGGER_KEY: KEY };

    expect(readTriggerKey(file, env)).toBe(other);
    expect(env.TRIGGER_KEY).toBeUndefined();

    expect(() => readTriggerKey(file, env)).not.toThrow();
    writeFileSync(file, "RPC_URL=x\n");
    expect(() => readTriggerKey(file, env)).toThrow("missing TRIGGER_KEY");
    expect(() => readTriggerKey(join(dir, "gone"), env)).toThrow("missing TRIGGER_KEY");
  });

  it("falls back to the process variable only when there is no env file, and still empties it", () => {
    const env: Record<string, string | undefined> = { TRIGGER_KEY: KEY };

    expect(readTriggerKey(join(dir, "gone"), env)).toBe(KEY);
    expect(env.TRIGGER_KEY).toBeUndefined();
  });

  it("gives the user CLI its own variables only, from its own file or from an older shared .env", () => {
    writeFileSync(join(dir, ".env"), `USER_SEED=shared\nTRIGGER_KEY=${KEY}\nPAYER_SEED=seed\nRPC_URL=http://shared\nHTTP_PORT=1\n`);
    const shared: Record<string, string | undefined> = { TRIGGER_KEY: "from the shell" };
    loadUserEnv(shared, dir);
    expect(shared).toEqual({ USER_SEED: "shared", RPC_URL: "http://shared" });

    writeFileSync(join(dir, ".env.user"), "USER_SEED=own\nFACTORY_ADDRESS=0x1\n");
    const own: Record<string, string | undefined> = { PAYER_SEED: "from the shell" };
    loadUserEnv(own, dir);
    expect(own).toEqual({ USER_SEED: "own", FACTORY_ADDRESS: "0x1" });

    writeFileSync(join(dir, "custom"), "USER_SEED=custom\nTRIGGER_KEY=nope\n");
    const named: Record<string, string | undefined> = { USER_ENV_FILE: "custom" };
    loadUserEnv(named, dir);
    expect(named).toEqual({ USER_ENV_FILE: "custom", USER_SEED: "custom" });
  });
});

describe("error descriptions", () => {
  it("uses viem's short message, which leaves the RPC URL out", () => {
    const error = new HttpRequestError({ url: "https://rpc.example/v3/secret-key", body: {}, details: "boom" });

    expect(error.message).toContain("secret-key");
    expect(describeError(error)).toBe("HTTP request failed.");
  });

  it("cuts URLs in any other message to their origin and shortens long ones", () => {
    expect(describeError(new Error("connect to wss://ah.example/path/KEY failed"))).toBe("connect to wss://ah.example failed");
    expect(describeError(new BaseError("short", { details: "x".repeat(10) }))).toBe("short");
    expect(describeError("y".repeat(400)).length).toBe(303);
  });
});
