import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { SERVICES_DIR } from "./config";

export type ManagedProcess = {
  name: string;
  logFile: string;
  signal: (signal: NodeJS.Signals) => void;
  stop: () => Promise<void>;
};

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

// Runs one of the services' entry points with only the given environment, logs its output to a file and resolves once `ready` shows up in it.
export async function startService(name: string, script: string, env: Record<string, string>, logFile: string, ready: RegExp): Promise<ManagedProcess> {
  mkdirSync(dirname(logFile), { recursive: true });
  const log = createWriteStream(logFile);
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: SERVICES_DIR,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (chunk: Buffer) => {
    output += chunk.toString();
    log.write(chunk);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }
    await exited;
    log.end();
  };

  const deadline = Date.now() + 60_000;
  while (!ready.test(output)) {
    if (child.exitCode !== null) throw new Error(`${name} exited with code ${child.exitCode} before it was ready; see ${logFile}`);
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`${name} was not ready within a minute; see ${logFile}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { name, logFile, signal: (signal) => void child.kill(signal), stop };
}
