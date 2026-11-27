import type { Address } from "viem";
import { describeError } from "../common/errors";
import { consoleLogger, type Logger } from "../common/log";
import type { Context, ServiceOptions } from "./context";
import { processDeposit } from "./front";
import { outstanding } from "./ledger";
import { alertUnsettled, follow } from "./settlement";
import type { DepositRecord, DepositStatus, PayoutStore } from "./store";
import type { AssetHubClient, EthereumClient, PoolParams, SentEvent } from "./types";

export type { ServiceOptions } from "./context";

export type Status = {
  state: "idle" | "running" | "stopped";
  payer: Address;
  pool: PoolParams & { frontFeeBps: number };
  caps: { maxPerDeposit: string; maxOutstanding: string; outstanding: string };
  payerFunds?: string;
  cursors: { ethereum?: string; assetHub?: number };
  counts: Record<DepositStatus, number>;
  unrepaid: DepositRecord[];
  reconcilePending: boolean;
  lastTickAt?: string;
  lastError?: string;
};

const MAX_ETHEREUM_RANGE = 1_000n;
const STATUSES: DepositStatus[] = ["queued", "fronted", "repaid", "unrepaid", "skipped", "reverted", "failed"];

export class PayoutService {
  private state: Status["state"] = "idle";
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<void> | undefined;
  private lastTickAt: string | undefined;
  private lastError: string | undefined;
  private readonly stopping = new AbortController();

  private constructor(private readonly ctx: Omit<Context, "signal">) {}

  // Without a cursor in the store there is no record of what was already seen, so the scan start has to be named.
  static async create(
    options: ServiceOptions,
    store: PayoutStore,
    ethereum: EthereumClient,
    assetHub: AssetHubClient,
    log: Logger = consoleLogger,
    clock: () => number = Date.now,
  ): Promise<PayoutService> {
    const params = await assetHub.poolParams();
    if (store.ethereumCursor === undefined) {
      if (options.startBlock === undefined) {
        throw new Error("the state file has no cursor, so the service cannot tell which deposits it has already seen; set START_BLOCK to the first Ethereum block to scan (the router's deploy block rebuilds everything)");
      }
      store.setEthereumCursor(options.startBlock - 1n);
    }
    if (store.assetHubCursor === undefined) store.setAssetHubCursor(await assetHub.blockNumber());
    return new PayoutService({ options, store, ethereum, assetHub, log, params, clock });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.state = "running";
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.state = "stopped";
    clearTimeout(this.timer);
    this.stopping.abort();
    await this.inflight;
  }

  tick(): Promise<void> {
    return (this.inflight ??= this.runTick().finally(() => {
      this.inflight = undefined;
    }));
  }

  records(): DepositRecord[] {
    return this.ctx.store.list();
  }

  record(depositId: string): DepositRecord | undefined {
    return this.ctx.store.get(depositId);
  }

  outstanding(): bigint {
    return outstanding(this.ctx.store);
  }

  async status(): Promise<Status> {
    const { store, options, assetHub, params } = this.ctx;
    const counts = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<DepositStatus, number>;
    for (const record of store.list()) counts[record.status]++;
    const payerFunds = await assetHub.funds(options.token).then(
      (funds) => funds.toString(),
      () => undefined,
    );
    return {
      state: this.state,
      payer: assetHub.payer,
      pool: { ...params, frontFeeBps: options.frontFeeBps },
      caps: {
        maxPerDeposit: options.maxPerDeposit.toString(),
        maxOutstanding: options.maxOutstanding.toString(),
        outstanding: this.outstanding().toString(),
      },
      payerFunds,
      cursors: { ethereum: store.ethereumCursor?.toString(), assetHub: store.assetHubCursor },
      counts,
      unrepaid: store.list().filter((record) => record.status === "unrepaid"),
      reconcilePending: store.needsReconcile,
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
    };
  }

  private get context(): Context {
    return { ...this.ctx, signal: this.stopping.signal };
  }

  // Settlements go first because they free exposure; what gave up is only retried after a pass without errors.
  private async runTick(): Promise<void> {
    const errors: string[] = [];
    const steps = [
      () => follow(this.context),
      () => this.discover(),
      () => this.frontQueued(errors.length === 0),
      () => alertUnsettled(this.context),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        errors.push(describeError(error));
      }
    }
    this.lastError = errors[0];
    if (errors.length > 0) this.ctx.log.warn("tick failed", { errors });
    this.lastTickAt = new Date(this.ctx.clock()).toISOString();
  }

  private async discover(): Promise<void> {
    const { ethereum, store, options } = this.ctx;
    const confirmed = (await ethereum.blockNumber()) - BigInt(options.confirmations);
    let cursor = store.ethereumCursor!;
    while (cursor < confirmed) {
      const to = cursor + MAX_ETHEREUM_RANGE < confirmed ? cursor + MAX_ETHEREUM_RANGE : confirmed;
      for (const sent of await ethereum.sentEvents(cursor + 1n, to)) this.admit(sent);
      cursor = to;
      store.setEthereumCursor(cursor);
    }
  }

  private admit(sent: SentEvent): void {
    const { store, log, clock } = this.ctx;
    const record: DepositRecord = {
      depositId: sent.depositId.toString(),
      account: sent.account,
      token: sent.token,
      amount: sent.amount.toString(),
      ethBlock: sent.blockNumber.toString(),
      ethTx: sent.txHash,
      seenAt: new Date(clock()).toISOString(),
      status: "queued",
      attempts: 0,
    };
    if (store.add(record)) return void log.info("deposit confirmed", { depositId: sent.depositId, amount: sent.amount, ethBlock: sent.blockNumber });

    const known = store.get(record.depositId)!;
    const differs = known.account.toLowerCase() !== record.account.toLowerCase() || known.token.toLowerCase() !== record.token.toLowerCase() || known.amount !== record.amount;
    if (differs) {
      log.error("a deposit id was reused with different fields; the first record is kept", {
        alert: "deposit-id-reused",
        depositId: record.depositId,
        known: { account: known.account, token: known.token, amount: known.amount, ethTx: known.ethTx },
        seen: { account: record.account, token: record.token, amount: record.amount, ethTx: record.ethTx },
      });
    }
  }

  private async frontQueued(healthy: boolean): Promise<void> {
    const { store, clock } = this.ctx;
    if (healthy) this.requeueFailed();
    for (const record of store.list()) {
      if (this.stopping.signal.aborted) return;
      if (record.status !== "queued") continue;
      if (record.nextAttemptAt !== undefined && clock() < record.nextAttemptAt) continue;
      await processDeposit(this.context, record);
    }
  }

  // A failure here is a transport failure, never a verdict, so the deposit is tried again once the chains answer.
  private requeueFailed(): void {
    const { store, log, clock } = this.ctx;
    for (const record of store.list()) {
      if (record.status !== "failed" || (record.nextAttemptAt !== undefined && clock() < record.nextAttemptAt)) continue;
      store.update(record.depositId, { status: "queued", attempts: 0, nextAttemptAt: undefined });
      log.info("deposit that gave up is queued again", { depositId: record.depositId, reason: record.reason });
    }
  }

  private schedule(delayMs: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.loop(), delayMs);
  }

  private async loop(): Promise<void> {
    await this.tick();
    if (this.running) this.schedule(this.ctx.options.pollIntervalMs);
  }
}
