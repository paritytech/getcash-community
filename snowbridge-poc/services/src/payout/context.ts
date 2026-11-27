import type { Logger } from "../common/log";
import type { Config } from "./config";
import type { PayoutStore } from "./store";
import type { AssetHubClient, EthereumClient, PoolParams } from "./types";

export type ServiceOptions = Pick<
  Config,
  | "token"
  | "confirmations"
  | "frontFeeBps"
  | "maxPerDeposit"
  | "maxOutstanding"
  | "startBlock"
  | "pollIntervalMs"
  | "maxAttempts"
  | "retryDelayMs"
  | "failedRetryMs"
  | "unsettledAlertMinutes"
>;

export type Context = {
  options: ServiceOptions;
  store: PayoutStore;
  ethereum: EthereumClient;
  assetHub: AssetHubClient;
  log: Logger;
  params: PoolParams;
  clock: () => number;
  // Aborted when the service stops, so a front waiting for inclusion does not hold the shutdown.
  signal: AbortSignal;
};
