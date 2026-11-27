import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "build");
mkdirSync(out, { recursive: true });

const combined = JSON.parse(
  execFileSync(
    "solc",
    ["--evm-version", "cancun", "--optimize", "--optimize-runs", "200", "--combined-json", "abi,bin", resolve(root, "contracts/Pool.sol")],
    { cwd: root, encoding: "utf8" },
  ),
);

const [key, artifact] = Object.entries(combined.contracts).find(([name]) => name.endsWith(":Pool"));
writeFileSync(
  resolve(out, "Pool.json"),
  JSON.stringify({ contract: key, abi: artifact.abi, bytecode: `0x${artifact.bin}` }, null, 2),
);
console.log(`wrote build/Pool.json (${artifact.bin.length / 2} bytes of init code)`);
