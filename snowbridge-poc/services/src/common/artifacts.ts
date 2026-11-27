import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Abi, Hex } from "viem";

const DEFAULT_OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../eth/out");

export type Artifact = { abi: Abi; bytecode: Hex };

// Foundry layout: <out>/<Source>.sol/<Contract>.json
export function loadArtifact(source: string, contract: string, outDir = process.env.ETH_OUT_DIR ?? DEFAULT_OUT_DIR): Artifact {
  const path = resolve(outDir, `${source}.sol`, `${contract}.json`);
  if (!existsSync(path)) throw new Error(`missing artifact ${path}; run \`pnpm build:contracts\``);
  const json = JSON.parse(readFileSync(path, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

export function loadForwarderCreationCode(outDir?: string): Hex {
  return loadArtifact("Forwarder", "Forwarder", outDir).bytecode;
}
