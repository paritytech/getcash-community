import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import type { Fields, Logger } from "../../src/common/log";
import type { Config } from "../../src/trigger/config";
import { FeeGuard } from "../../src/trigger/fees";
import { createHttpServer } from "../../src/trigger/server";
import { TriggerService } from "../../src/trigger/service";
import { Store } from "../../src/trigger/store";
import { FakeFeeSource } from "./fees";
import { EXECUTION_FEE, type Stack } from "./stack";

export type LogLine = { level: "info" | "warn" | "error"; message: string; fields: Fields };

export type Harness = Awaited<ReturnType<typeof startHarness>>;

export type HarnessOptions = {
  source?: FakeFeeSource;
  now?: () => number;
  store?: (stateFile: string) => Store;
};

export async function startHarness(stack: Stack, overrides: Partial<Config> = {}, triggerKey: Hex = stack.trigger.key, options: HarnessOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "trigger-test-"));
  const config: Config = {
    rpcUrl: stack.rpcUrl,
    assetHubWs: "ws://127.0.0.1:1",
    factory: stack.factory,
    tokens: [stack.token],
    minTriggerAmount: { perToken: {} },
    executionFee: EXECUTION_FEE,
    executionFeeMarginMilli: 1200n,
    relayerFee: 0n,
    pollIntervalMs: 50,
    maxBackoffMs: 400,
    receiptTimeoutMs: 20_000,
    quoteIntervalMs: 60_000,
    quoteMaxAgeMs: 300_000,
    quoteTimeoutMs: 1_000,
    triggerKey,
    stateFile: join(dir, "state.json"),
    httpHost: "127.0.0.1",
    httpPort: 0,
    ...overrides,
  };

  const logs: LogLine[] = [];
  const capture = (level: LogLine["level"]) => (message: string, fields: Fields = {}) => void logs.push({ level, message, fields });
  const log: Logger = { info: capture("info"), warn: capture("warn"), error: capture("error") };

  const source = options.source ?? new FakeFeeSource();
  const store = options.store?.(config.stateFile) ?? new Store(config.stateFile);
  const service = await TriggerService.create(
    config,
    store,
    () => new FeeGuard(source, { marginMilli: config.executionFeeMarginMilli, maxAgeMs: config.quoteMaxAgeMs, retryAfterMs: 0, now: options.now }),
    log,
  );
  const server = createHttpServer(service, store, log);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    config,
    service,
    store,
    source,
    logs,
    baseUrl,
    close: async () => {
      await service.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
