import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import type { Hex } from "viem";
import { parseTriggerKey } from "./config";

type Env = Record<string, string | undefined>;

// Startup and SIGHUP read the key the same way: the env file when it has one, else the process environment, which is emptied either way so no copy outlives the read.
export function readTriggerKey(envFile: string, env: Env = process.env): Hex {
  const fromFile = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")).TRIGGER_KEY : undefined;
  const value = fromFile ?? env.TRIGGER_KEY;
  delete env.TRIGGER_KEY;
  return parseTriggerKey(value);
}
