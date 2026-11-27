import { createPublicClient, erc20Abi, http, isAddressEqual, type Address, type Chain, type Hex, type PublicClient } from "viem";
import { factoryAbi, registryAbi } from "../common/abi";
import { resolveChain } from "../common/chain";
import { consoleLogger, type Logger } from "../common/log";
import { classifyFailure } from "./failure";
import type { Config } from "./config";
import type { FeeGuard, FeeStatus } from "./fees";
import type { DeliveryTemplate } from "./quote";
import { RelayerWatch } from "./relayerWatch";
import { ensureDeployed, makeSigner, sendTrigger, type SendContext, type Signer } from "./send";
import { verifyDeployment, type Deployment } from "./startup";
import type { Registration, Store } from "./store";

export type ServiceState = "idle" | "running" | "paused" | "stopped";

export type Status = {
  state: ServiceState;
  triggerAddress: Address;
  registryRelayer?: Address;
  registryPaused?: boolean;
  registrations: number;
  quarantined: number;
  executionFee: FeeStatus;
  nextDelayMs: number;
  lastTickAt?: string;
  lastError?: string;
};

export type FeeContext = { router: Address; ethereumChainId: bigint; template: DeliveryTemplate };

const QUOTE_ACCOUNT: Hex = `0x${"00".repeat(32)}`;

export class TriggerService {
  private state: ServiceState = "idle";
  private signer: Signer;
  private backoffMs = 0;
  private failures = new Map<string, { count: number; retryAt: number }>();
  private dustSeen = new Map<string, bigint>();
  private running = false;
  private wakeRequested = false;
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<void> | undefined;
  private lastRegistry: { relayer: Address; paused: boolean } | undefined;
  private lastTickAt: string | undefined;
  private lastError: string | undefined;
  private readonly allowlist: Set<string>;
  private readonly watch: RelayerWatch;
  readonly router: Address;

  private constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly fees: FeeGuard,
    private readonly log: Logger,
    private readonly chain: Chain,
    private readonly publicClient: PublicClient,
    private readonly deployment: Deployment,
  ) {
    this.signer = makeSigner(config.triggerKey, chain, config.rpcUrl);
    this.allowlist = new Set(config.tokens.map((token) => token.toLowerCase()));
    this.router = deployment.router;
    this.watch = new RelayerWatch(publicClient, deployment.registry, deployment.head + 1n, log);
  }

  static async create(config: Config, store: Store, buildFees: (context: FeeContext) => FeeGuard, log: Logger = consoleLogger): Promise<TriggerService> {
    const chain = await resolveChain(config.rpcUrl);
    const publicClient: PublicClient = createPublicClient({ chain, transport: http(config.rpcUrl), pollingInterval: 500 });
    const deployment = await verifyDeployment(publicClient, config, store, log);
    const fees = buildFees({ router: deployment.router, ethereumChainId: BigInt(chain.id), template: deployment.template });
    return new TriggerService(config, store, fees, log, chain, publicClient, deployment);
  }

  get triggerAddress(): Address {
    return this.signer.account.address;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    await this.inflight;
    await this.fees.close();
  }

  // Only checks an address the phone sent; the service never hands one out.
  predict(account: Hex, owner: Address): Promise<Address> {
    return this.publicClient.readContract({ address: this.config.factory, abi: factoryAbi, functionName: "predict", args: [account, owner] });
  }

  // The next tick decides whether the new key is the registry's relayer.
  setKey(key: Hex): Address {
    this.signer = makeSigner(key, this.chain, this.config.rpcUrl);
    this.failures.clear();
    this.log.info("trigger key replaced", { triggerAddress: this.signer.account.address });
    this.wake();
    return this.signer.account.address;
  }

  status(): Status {
    return {
      state: this.state,
      triggerAddress: this.signer.account.address,
      registryRelayer: this.lastRegistry?.relayer,
      registryPaused: this.lastRegistry?.paused,
      registrations: this.registrations().length,
      quarantined: this.deployment.quarantined.size,
      executionFee: this.fees.status(this.config.executionFee),
      nextDelayMs: this.nextDelayMs(),
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
    };
  }

  nextDelayMs(): number {
    return Math.max(this.config.pollIntervalMs, this.backoffMs);
  }

  tick(): Promise<void> {
    return (this.inflight ??= this.runTick().finally(() => {
      this.inflight = undefined;
    }));
  }

  async processToken(registration: Registration, token: Address): Promise<void> {
    if (!this.allowlist.has(token.toLowerCase())) throw new Error(`token ${token} is not allowlisted`);
    const signer = this.signer;
    const itemKey = `${registration.address}:${token}`;
    if (this.cooling(itemKey)) return;

    try {
      const balance = await this.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [registration.address] });
      if (balance === 0n) return void this.failures.delete(itemKey);
      if (balance < this.deployment.minAmounts.get(token.toLowerCase())!) return this.noteDust(itemKey, registration, token, balance);

      await this.fees.check({ account: registration.account, token, amount: balance }, this.config.executionFee);
      const ctx = this.sendContext();
      await ensureDeployed(ctx, signer, registration);
      await sendTrigger(ctx, signer, registration, token);
      this.failures.delete(itemKey);
    } catch (error) {
      this.handleFailure(registration, token, itemKey, error);
    }
  }

  private registrations(): Registration[] {
    return this.store.list().filter((registration) => !this.deployment.quarantined.has(registration.address.toLowerCase()));
  }

  private sendContext(): SendContext {
    return { publicClient: this.publicClient, config: this.config, router: this.router, store: this.store, log: this.log };
  }

  private async runTick(): Promise<void> {
    try {
      await this.watch.poll();
      const [relayer, paused] = await Promise.all([
        this.publicClient.readContract({ address: this.deployment.registry, abi: registryAbi, functionName: "relayer" }),
        this.publicClient.readContract({ address: this.deployment.registry, abi: registryAbi, functionName: "paused" }),
      ]);
      this.lastRegistry = { relayer, paused };

      if (!isAddressEqual(relayer, this.signer.account.address)) return this.enter("stopped");
      if (paused) {
        this.enter("paused");
        return this.growBackoff();
      }
      this.enter("running");
      this.backoffMs = 0;

      if (this.fees.ageMs() >= this.config.quoteIntervalMs) {
        await this.fees.refresh({ account: QUOTE_ACCOUNT, token: this.deployment.routerToken, amount: 1n });
      }
      for (const registration of this.registrations()) {
        for (const token of this.config.tokens) {
          if (this.state !== "running") return;
          await this.processToken(registration, token);
        }
      }
      this.lastError = undefined;
    } catch (error) {
      const failure = classifyFailure(error);
      this.lastError = failure.kind === "other" || failure.kind === "fee" ? failure.message : failure.kind;
      this.log.warn("tick failed", { error: this.lastError });
      this.growBackoff();
    } finally {
      this.lastTickAt = new Date().toISOString();
    }
  }

  private noteDust(itemKey: string, registration: Registration, token: Address, balance: bigint): void {
    this.failures.delete(itemKey);
    if (this.dustSeen.get(itemKey) === balance) return;
    this.dustSeen.set(itemKey, balance);
    const minimum = this.deployment.minAmounts.get(token.toLowerCase());
    this.log.info("balance is below the minimum trigger amount; left in the forwarder", { forwarder: registration.address, token, balance, minimum });
  }

  private handleFailure(registration: Registration, token: Address, itemKey: string, error: unknown): void {
    const failure = classifyFailure(error);
    const fields = { forwarder: registration.address, token };
    switch (failure.kind) {
      case "rotated":
        return this.enter("stopped");
      case "paused":
        this.enter("paused");
        return this.growBackoff();
      case "nothing-to-forward":
        return;
      case "fee": {
        this.lastError = failure.message;
        const retryInMs = this.coolDown(itemKey);
        return this.log.error("execution fee refused; nothing was triggered", { ...fields, alert: "execution-fee", error: failure.message, retryInMs });
      }
      case "other": {
        this.lastError = failure.message;
        this.log.warn("trigger failed", { ...fields, error: failure.message, retryInMs: this.coolDown(itemKey) });
      }
    }
  }

  private coolDown(itemKey: string): number {
    const count = (this.failures.get(itemKey)?.count ?? 0) + 1;
    const delay = Math.min(this.config.maxBackoffMs, this.config.pollIntervalMs * 2 ** count);
    this.failures.set(itemKey, { count, retryAt: Date.now() + delay });
    return delay;
  }

  private cooling(itemKey: string): boolean {
    const failure = this.failures.get(itemKey);
    return failure !== undefined && Date.now() < failure.retryAt;
  }

  private enter(next: ServiceState): void {
    if (next === this.state) return;
    const previous = this.state;
    this.state = next;
    const fields = { triggerAddress: this.signer.account.address, registryRelayer: this.lastRegistry?.relayer };
    switch (next) {
      case "stopped":
        return this.log.error(
          "trigger key is not registry.relayer(); triggering stopped until a matching key is supplied or the registry relayer is set back",
          fields,
        );
      case "paused":
        return this.log.warn("registry is paused; backing off", fields);
      case "running":
        return this.log.info(previous === "idle" ? "triggering started" : "triggering resumed", fields);
    }
  }

  private growBackoff(): void {
    this.backoffMs = Math.min(this.config.maxBackoffMs, (this.backoffMs || this.config.pollIntervalMs) * 2);
  }

  private schedule(delayMs: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.loop(), delayMs);
  }

  private async loop(): Promise<void> {
    await this.tick();
    if (!this.running) return;
    const delay = this.wakeRequested ? 0 : this.nextDelayMs();
    this.wakeRequested = false;
    this.schedule(delay);
  }

  private wake(): void {
    if (!this.running) return;
    if (this.inflight) this.wakeRequested = true;
    else this.schedule(0);
  }
}
