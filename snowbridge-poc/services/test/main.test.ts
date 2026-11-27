import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getDeposits } from "../src/user";
import { startAnvil, type Anvil } from "./helpers/anvil";
import { newDepositor } from "./helpers/depositor";
import { EXECUTION_FEE, callRegistry, deployStack, tokenBalance, waitFor, type Stack } from "./helpers/stack";

const servicesDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let anvil: Anvil;

beforeAll(async () => {
  anvil = await startAnvil();
});

afterAll(async () => {
  await anvil.stop();
});

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolvePort(port));
    });
  });
}

// Asset Hub is pointed at a closed port, so the real stack is never touched and no quote can be had.
function runTrigger(stack: Stack, dir: string, envFile: string, port: number, overrides: Record<string, string> = {}) {
  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "src/trigger/main.ts"], {
    cwd: servicesDir,
    env: {
      PATH: process.env.PATH,
      ENV_FILE: envFile,
      RPC_URL: stack.rpcUrl,
      ASSET_HUB_WS: "ws://127.0.0.1:1",
      QUOTE_TIMEOUT_MS: "500",
      FACTORY_ADDRESS: stack.factory,
      TOKEN_ALLOWLIST: stack.token,
      EXECUTION_FEE_WEI: EXECUTION_FEE.toString(),
      POLL_INTERVAL_MS: "100",
      HTTP_PORT: String(port),
      STATE_FILE: join(dir, "state.json"),
      ...overrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((resolveExit) => child.once("exit", (code) => resolveExit(code)));
  return { child, exited, output: () => output };
}

it("runs as a process, refuses to trigger without a fee quote, and takes a rotated key from the env file on SIGHUP", async () => {
  const stack = await deployStack(anvil.url);
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "trigger-main-"));
  const envFile = join(dir, ".env");
  writeFileSync(envFile, `TRIGGER_KEY=${stack.trigger.key}\nPAYER_SEED=must-not-matter\n`);
  const { child, exited, output } = runTrigger(stack, dir, envFile, port);

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitFor(async () => output().includes("trigger service listening"));
    const status = async () =>
      (await (await fetch(`${baseUrl}/status`)).json()) as {
        state: string;
        triggerAddress: string;
        registryRelayer?: string;
        executionFee: { quoteError?: string };
      };

    const gina = newDepositor(stack, "gina");
    await gina.register(baseUrl);
    await gina.send(stack.token, 3_000_000n);
    await waitFor(async () => (await status()).executionFee.quoteError !== undefined);
    expect((await status()).triggerAddress).toBe(stack.trigger.account.address);
    expect((await getDeposits(baseUrl, gina.deposit)).deposits).toHaveLength(0);
    expect(await tokenBalance(stack, stack.token, gina.deposit)).toBe(3_000_000n);

    const rotated = await stack.newWallet();
    await callRegistry(stack, stack.admin, "setRelayer", rotated.account.address);
    await waitFor(async () => (await status()).state === "stopped");

    writeFileSync(envFile, `TRIGGER_KEY=${rotated.key}\n`);
    child.kill("SIGHUP");
    await waitFor(async () => {
      const current = await status();
      return current.state === "running" && current.triggerAddress === rotated.account.address;
    });

    writeFileSync(envFile, "\n");
    child.kill("SIGHUP");
    await waitFor(async () => output().includes("trigger key reload failed"));
    expect((await status()).triggerAddress).toBe(rotated.account.address);

    expect(output()).not.toContain(stack.trigger.key.slice(2));
    expect(output()).not.toContain(rotated.key.slice(2));
  } finally {
    child.kill("SIGTERM");
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

it("refuses to start when the allowlist names a token other than the router's", async () => {
  const stack = await deployStack(anvil.url);
  const dir = mkdtempSync(join(tmpdir(), "trigger-main-"));
  const envFile = join(dir, ".env");
  writeFileSync(envFile, `TRIGGER_KEY=${stack.trigger.key}\n`);
  const other = await stack.deployNamed("Mocks", "MockERC20", ["OTHER"]);
  const { exited, output } = runTrigger(stack, dir, envFile, await freePort(), { TOKEN_ALLOWLIST: `${stack.token},${other}` });

  try {
    expect(await exited).not.toBe(0);
    expect(output()).toContain(`TOKEN_ALLOWLIST entry ${other} is not the router's token ${stack.token}`);
    expect(output()).not.toContain("trigger service listening");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
