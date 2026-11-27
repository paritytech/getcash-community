import { dropEnv, loadScopedEnvFile } from "../common/env";
import { describeError } from "../common/errors";
import { consoleLogger as log } from "../common/log";
import { PolkadotAssetHubClient } from "./assetHub";
import { describeConfig, loadConfig, PAYOUT_ENV_KEYS } from "./config";
import { viemEthereumClient } from "./ethereum";
import { createHttpServer } from "./server";
import { PayoutService } from "./service";
import { PayoutStore } from "./store";

// The trigger key and the user seed have no business in this process, whatever the shell or a shared file holds.
dropEnv(["TRIGGER_KEY", "USER_SEED"]);
loadScopedEnvFile(process.env.PAYOUT_ENV_FILE ?? ".env.payout", PAYOUT_ENV_KEYS);

const config = loadConfig(process.env);
const assetHub = await PolkadotAssetHubClient.connect(config.assetHubWs, config.payerSeed, config.pool, { submitTimeoutMs: config.submitTimeoutMs });
const service = await PayoutService.create(
  config,
  new PayoutStore(config.stateFile),
  viemEthereumClient(config.ethereumRpcUrl, config.router),
  assetHub,
  log,
).catch(async (error: unknown) => {
  log.error("payout service cannot start", { error: describeError(error) });
  await assetHub.close();
  process.exit(1);
});
const server = createHttpServer(service, log);

await new Promise<void>((resolve) => server.listen(config.httpPort, config.httpHost, resolve));
log.info("payout service listening", { ...describeConfig(config), payer: assetHub.payer });
service.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    void service.stop().then(() => assetHub.close()).then(() => process.exit(0));
  });
}
