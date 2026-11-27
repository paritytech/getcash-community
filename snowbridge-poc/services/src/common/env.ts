import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

type Env = Record<string, string | undefined>;

// Applies only the named keys, so a file shared with another service cannot bring that service's secrets in; variables already set win.
export function loadScopedEnvFile(path: string, keys: readonly string[], env: Env = process.env): boolean {
  if (!existsSync(path)) return false;
  const values = parseEnv(readFileSync(path, "utf8"));
  for (const key of keys) {
    if (values[key] !== undefined && env[key] === undefined) env[key] = values[key];
  }
  return true;
}

export function dropEnv(names: readonly string[], env: Env = process.env): void {
  for (const name of names) delete env[name];
}
