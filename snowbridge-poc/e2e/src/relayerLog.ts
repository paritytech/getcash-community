import { existsSync, readFileSync, statSync } from "node:fs";
import { OUTPUT_DIR } from "../../assethub/src/constants";
import { sleep } from "./chains";

export const STACK_DIR = OUTPUT_DIR;
export const RELAYER_LOG = `${STACK_DIR}/ethereum-relay-v3.log`;

export type LogLine = { time: string; level: string; message: string; nonce?: number; fields: Record<string, unknown> };

export const OURS_MODE = "[getcash] ours-only mode";
export const NOT_OURS = "[getcash] not ours; skipping";
// The batch path logs "... submit in force_batch", the catch-up path "catch-up: Including ... submit".
export const INCLUDED = "Including EthereumInboundQueueV2.submit";
export const PROCESSED = "Message successfully processed";

// Reads the stack's ethereum-v3 relayer log by byte offset, so a scenario only looks at what happened after it started.
export class RelayerLog {
  constructor(private readonly file: string = RELAYER_LOG) {}

  mark(): number {
    return existsSync(this.file) ? statSync(this.file).size : 0;
  }

  lines(from = 0): LogLine[] {
    if (!existsSync(this.file)) return [];
    const bytes = readFileSync(this.file);
    const text = bytes.subarray(from > bytes.length ? 0 : from).toString("utf8");
    const parsed: LogLine[] = [];
    for (const raw of text.split("\n")) {
      if (!raw.startsWith("{")) continue;
      try {
        const fields = JSON.parse(raw) as Record<string, unknown>;
        parsed.push({
          time: String(fields["@timestamp"] ?? ""),
          level: String(fields.level ?? ""),
          message: String(fields.message ?? ""),
          nonce: typeof fields.nonce === "number" ? fields.nonce : undefined,
          fields,
        });
      } catch {
        // a line still being written
      }
    }
    return parsed;
  }

  find(from: number, message: string, nonce?: bigint | number): LogLine[] {
    return this.lines(from).filter((line) => line.message.includes(message) && (nonce === undefined || line.nonce === Number(nonce)));
  }

  async waitFor(what: string, from: number, message: string, nonce: bigint | number | undefined, timeoutMs: number): Promise<LogLine> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.find(from, message, nonce)[0];
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for the relayer log: ${what}`);
      await sleep(1_000);
    }
  }

  // The lines that show what the relayer did with one nonce, oldest first.
  trail(from: number, nonce: bigint | number): LogLine[] {
    const interesting = [NOT_OURS, INCLUDED, PROCESSED, "our message needs attention", "Message submission failed"];
    return this.lines(from).filter((line) => line.nonce === Number(nonce) && interesting.some((marker) => line.message.includes(marker)));
  }
}

export const describeLine = (line: LogLine): string => `${line.time} ${line.message}${line.nonce !== undefined ? ` (nonce ${line.nonce})` : ""}`;
