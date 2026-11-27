import "./quietPolkadot";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { connectBridgeHub, finalizedBeaconSlot } from "./bridgehub";
import { SNOWBRIDGE_DIR } from "../../assethub/src/constants";
import { waitFor } from "./chains";
import { E2E_DIR } from "./config";
import { readDeployment, type E2eDeployment } from "./deployment";
import { OURS_MODE, RelayerLog, STACK_DIR, describeLine } from "./relayerLog";

export const RELAYER_BIN = `${STACK_DIR}/bin/snowbridge-relay`;
export const RELAYER_CONFIG = `${STACK_DIR}/ethereum-v3.json`;
export const PATCHED_BIN = process.env.GC_PATCHED_RELAYER ?? join(SNOWBRIDGE_DIR, "relayer/build/snowbridge-relay");
export const DEAD_NONCES = `${STACK_DIR}/ethereum-v3-gc-dead-nonces.json`;
export const SWAP_LOG = join(E2E_DIR, "data", "relayer-swap.log");

const STOCK_SUFFIX = ".stock";
const PATCH_MARKER = "ours-only mode: delivering only router messages";
const SELECTOR = "snowbridge-relay run ethereum-v3";
const RESTART_TIMEOUT_MS = 90_000;
const BEACON_TIMEOUT_MS = 240_000;

export type RelayerProcess = { pid: number; command: string };

// The stack's start script runs the relayer in a loop; only the ethereum-v3 process is ever touched here.
export function ethereumRelayers(): RelayerProcess[] {
  const listing = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return listing.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match && match[2]!.startsWith(`${RELAYER_BIN} run ethereum-v3`) ? [{ pid: Number(match[1]), command: match[2]! }] : [];
  });
}

export const isPatchedBinary = (path: string): boolean => readFileSync(path).includes(PATCH_MARKER);
const isPatchedConfig = (path: string): boolean => "getcash" in (JSON.parse(readFileSync(path, "utf8")) as object);

export function getcashBlock(dep: E2eDeployment) {
  return { enabled: true, registry: dep.registry, routers: [dep.router], "registry-deploy-block": Number(dep.registryDeployBlock), "registry-log-chunk": 10_000 };
}

// The stack's generated config plus the getcash block and a dead-nonce file of its own.
export function patchedConfig(stock: Record<string, unknown>, dep: E2eDeployment): Record<string, unknown> {
  return { ...stock, deadNoncesPath: DEAD_NONCES, getcash: getcashBlock(dep) };
}

function writeAtomic(path: string, text: string): void {
  writeFileSync(`${path}.new`, text);
  renameSync(`${path}.new`, path);
}

const sameFile = (a: string, b: string): boolean => readFileSync(a).equals(readFileSync(b));

// Other relayers run from this file, so it is replaced by a rename and never written in place. A stack built from the fork already
// carries the patch (dormant without a getcash block), so an identical binary is left alone.
function installBinary(source: string): string {
  if (sameFile(source, RELAYER_BIN)) return "the stack's binary is already identical, left in place";
  copyFileSync(source, `${RELAYER_BIN}.new`);
  chmodSync(`${RELAYER_BIN}.new`, 0o755);
  renameSync(`${RELAYER_BIN}.new`, RELAYER_BIN);
  return `installed ${source}`;
}

export type Restart = { oldPid: number; newPid: number; restartSeconds: number; offset: number };

// Kills the ethereum-v3 process, as `pkill -f` does, and waits for the stack's loop to start it again.
export async function restartEthereumRelayer(log: RelayerLog): Promise<Restart> {
  const before = ethereumRelayers();
  if (before.length !== 1) throw new Error(`expected one ethereum-v3 relayer, found ${before.length}`);
  const offset = log.mark();
  const killedAt = Date.now();
  spawnSync("pkill", ["-f", SELECTOR]);
  const started = await waitFor("the stack's loop to start ethereum-v3 again", async () => {
    const running = ethereumRelayers();
    return running.length === 1 && running[0]!.pid !== before[0]!.pid && running[0];
  }, RESTART_TIMEOUT_MS, 500);
  return { oldPid: before[0]!.pid, newPid: started.pid, restartSeconds: (Date.now() - killedAt) / 1000, offset };
}

async function confirmRestart(log: RelayerLog, restart: Restart, patched: boolean): Promise<string[]> {
  const out: string[] = [];
  if (patched) {
    const line = await log.waitFor("the getcash filter starting", restart.offset, OURS_MODE, undefined, 120_000);
    out.push(`getcash filter started: ${describeLine(line)}`);
  } else {
    await log.waitFor("the stock relayer starting", restart.offset, "Using beacon state service", undefined, 120_000);
    if (log.find(restart.offset, OURS_MODE).length > 0) throw new Error("the restarted relayer still runs the getcash filter");
    out.push("stock relayer started, no getcash filter");
  }
  // The old process logs "context canceled" as it is killed.
  const errors = log.lines(restart.offset).filter((line) => (line.level === "error" || line.level === "fatal") && line.fields.error !== "context canceled");
  out.push(`${errors.length} error lines in the log since the restart${errors[0] ? `, first: ${errors[0].message}` : ""}`);
  return out;
}

async function confirmBeaconAdvances(startSlot: number): Promise<string> {
  const bridgeHub = await connectBridgeHub();
  try {
    const slot = await waitFor("the beacon light client to advance", async () => {
      const current = await finalizedBeaconSlot(bridgeHub);
      return current > startSlot && current;
    }, BEACON_TIMEOUT_MS, 5_000);
    return `beacon light client advanced from slot ${startSlot} to ${slot}`;
  } finally {
    await bridgeHub.disconnect();
  }
}

async function currentBeaconSlot(): Promise<number> {
  const bridgeHub = await connectBridgeHub();
  try {
    return await finalizedBeaconSlot(bridgeHub);
  } finally {
    await bridgeHub.disconnect();
  }
}

function requireStockProcess(): RelayerProcess {
  const running = ethereumRelayers();
  if (running.length !== 1) throw new Error(`expected exactly one ethereum-v3 relayer from ${RELAYER_BIN}, found ${running.length}`);
  const [relayer] = running;
  if (!relayer!.command.includes(`--config ${RELAYER_CONFIG}`)) throw new Error("the running ethereum-v3 relayer does not use the stack's config path");
  return relayer!;
}

export async function swapToPatched(dep: E2eDeployment, log = new RelayerLog()): Promise<string[]> {
  const out: string[] = [];
  const running = requireStockProcess();
  for (const path of [RELAYER_CONFIG, RELAYER_BIN]) {
    const stock = `${path}${STOCK_SUFFIX}`;
    if (existsSync(stock)) continue;
    if (path === RELAYER_CONFIG && isPatchedConfig(path)) throw new Error(`${path} already has a getcash block and no ${STOCK_SUFFIX} backup; restore the stock config first`);
    copyFileSync(path, stock, constants.COPYFILE_EXCL);
    out.push(`backed up ${path} as ${stock}`);
  }

  const stockConfig = JSON.parse(readFileSync(`${RELAYER_CONFIG}${STOCK_SUFFIX}`, "utf8")) as Record<string, unknown>;
  const config = `${JSON.stringify(patchedConfig(stockConfig, dep), null, 2)}\n`;
  const sameConfig = readFileSync(RELAYER_CONFIG, "utf8") === config;
  if (sameConfig && sameFile(RELAYER_BIN, PATCHED_BIN)) {
    out.push(`already swapped; ethereum-v3 runs as pid ${running.pid}`);
    return out;
  }

  const probe = spawnSync(PATCHED_BIN, ["run", "ethereum-v3", "--help"], { encoding: "utf8" });
  if (probe.status !== 0) throw new Error(`the patched relayer does not start: ${probe.stderr}`);
  const startSlot = await currentBeaconSlot();

  writeAtomic(RELAYER_CONFIG, config);
  out.push(installBinary(PATCHED_BIN));
  out.push(`wrote the getcash config (registry ${dep.registry}, router ${dep.router}, deploy block ${dep.registryDeployBlock})`);

  const restart = await restartEthereumRelayer(log);
  out.push(`ethereum-v3 restarted by the stack's loop in ${restart.restartSeconds.toFixed(1)} s (pid ${restart.oldPid} -> ${restart.newPid})`);
  out.push(...(await confirmRestart(log, restart, true)));
  out.push(await confirmBeaconAdvances(startSlot));
  return out;
}

export async function revertToStock(log = new RelayerLog()): Promise<string[]> {
  const out: string[] = [];
  requireStockProcess();
  for (const path of [RELAYER_CONFIG, RELAYER_BIN]) {
    if (!existsSync(`${path}${STOCK_SUFFIX}`)) throw new Error(`no ${path}${STOCK_SUFFIX} backup to restore`);
  }
  const startSlot = await currentBeaconSlot();
  writeAtomic(RELAYER_CONFIG, readFileSync(`${RELAYER_CONFIG}${STOCK_SUFFIX}`, "utf8"));
  out.push("restored the stock config", installBinary(`${RELAYER_BIN}${STOCK_SUFFIX}`));
  const restart = await restartEthereumRelayer(log);
  out.push(`ethereum-v3 restarted by the stack's loop in ${restart.restartSeconds.toFixed(1)} s (pid ${restart.oldPid} -> ${restart.newPid})`);
  out.push(...(await confirmRestart(log, restart, false)));
  out.push(await confirmBeaconAdvances(startSlot));
  return out;
}

export type RelayerStatus = { pid?: number; patchedBinary: boolean; configMatchesDeployment: boolean; getcash?: Record<string, unknown>; backups: boolean };

export function relayerStatus(dep: E2eDeployment): RelayerStatus {
  const running = ethereumRelayers();
  const config = JSON.parse(readFileSync(RELAYER_CONFIG, "utf8")) as { getcash?: Record<string, unknown> };
  const expected = getcashBlock(dep);
  return {
    pid: running[0]?.pid,
    patchedBinary: isPatchedBinary(RELAYER_BIN),
    configMatchesDeployment: JSON.stringify(config.getcash) === JSON.stringify(expected),
    getcash: config.getcash,
    backups: existsSync(`${RELAYER_CONFIG}${STOCK_SUFFIX}`) && existsSync(`${RELAYER_BIN}${STOCK_SUFFIX}`),
  };
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const dep = readDeployment();
  if (command === "swap") {
    const lines = await swapToPatched(dep);
    for (const line of lines) console.log(`  ${line}`);
    mkdirSync(dirname(SWAP_LOG), { recursive: true });
    writeFileSync(SWAP_LOG, `${lines.join("\n")}\n`);
  } else if (command === "revert") for (const line of await revertToStock()) console.log(`  ${line}`);
  else if (command === "status") console.log(JSON.stringify(relayerStatus(dep), null, 2));
  else throw new Error("usage: relayer.ts swap | revert | status");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
