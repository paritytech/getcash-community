import { join } from "node:path";
import { dropEnv, loadScopedEnvFile } from "../common/env";

export const USER_ENV_KEYS = ["USER_SEED", "FACTORY_ADDRESS", "RPC_URL", "TRIGGER_URL"] as const;

type Env = Record<string, string | undefined>;

// The CLI signs as the user, so the service keys must never reach it. It falls back to `.env` for older setups, but takes only its own variables from there.
export function loadUserEnv(env: Env = process.env, dir = process.cwd()): void {
  dropEnv(["TRIGGER_KEY", "PAYER_SEED"], env);
  if (env.USER_ENV_FILE) {
    loadScopedEnvFile(join(dir, env.USER_ENV_FILE), USER_ENV_KEYS, env);
  } else if (!loadScopedEnvFile(join(dir, ".env.user"), USER_ENV_KEYS, env)) {
    loadScopedEnvFile(join(dir, ".env"), USER_ENV_KEYS, env);
  }
}
