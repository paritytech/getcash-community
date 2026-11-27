import { spawn, type ChildProcess } from "node:child_process";

export type Anvil = { url: string; stop: () => Promise<void> };

const LISTENING = /Listening on ([\d.]+):(\d+)/;

// Port 0 lets the OS pick a free port; anvil prints the one it got.
export async function startAnvil(): Promise<Anvil> {
  const child = spawn("anvil", ["--host", "127.0.0.1", "--port", "0", "--accounts", "0", "--chain-id", "31337"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = await readUrl(child);
  return { url, stop: () => stopProcess(child) };
}

function readUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("anvil did not report a port in time")), 20_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = LISTENING.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(`http://${match[1]}:${match[2]}`);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`anvil exited with code ${code} before listening`));
    });
  });
}

function stopProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.removeAllListeners("exit");
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  });
}
