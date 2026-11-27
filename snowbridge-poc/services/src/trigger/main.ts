import { dropEnv, loadScopedEnvFile } from "../common/env";
import { describeError } from "../common/errors";
import { consoleLogger as log } from "../common/log";
import { describeConfig, loadConfig, TRIGGER_ENV_KEYS } from "./config";
import { FeeGuard } from "./fees";
import { readTriggerKey } from "./key";
import { AssetHubFeeSource } from "./quote";
import { createHttpServer } from "./server";
import { TriggerService } from "./service";
import { Store } from "./store";

// The payer seed and the user seed have no business in this process, whatever the shell or a shared file holds.
dropEnv(["PAYER_SEED", "USER_SEED"]);
const envFile = process.env.ENV_FILE ?? ".env";
loadScopedEnvFile(envFile, TRIGGER_ENV_KEYS);

const config = loadConfig({ ...process.env, TRIGGER_KEY: readTriggerKey(envFile) });
const store = new Store(config.stateFile);
const service = await TriggerService.create(
  config,
  store,
  (context) =>
    new FeeGuard(AssetHubFeeSource.viaWebSocket(config.assetHubWs, { ...context, timeoutMs: config.quoteTimeoutMs }), {
      marginMilli: config.executionFeeMarginMilli,
      maxAgeMs: config.quoteMaxAgeMs,
      retryAfterMs: config.pollIntervalMs,
    }),
  log,
);
const server = createHttpServer(service, store, log);

await new Promise<void>((resolve) => server.listen(config.httpPort, config.httpHost, resolve));
log.info("trigger service listening", { ...describeConfig(config), triggerAddress: service.triggerAddress, router: service.router });
service.start();

process.on("SIGHUP", () => {
  try {
    service.setKey(readTriggerKey(envFile));
  } catch (error) {
    log.error("trigger key reload failed", { error: describeError(error) });
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    void service.stop().then(() => process.exit(0));
  });
}
