import { getAddress, type Address, type Hex } from "viem";
import type { Fields, Logger } from "../../src/common/log";
import { DepositStatus } from "../../src/payout/abi";
import { PayoutService, type ServiceOptions } from "../../src/payout/service";
import { PayoutStore } from "../../src/payout/store";
import type {
  AssetHubClient,
  DepositKey,
  EthereumClient,
  FrontOutcome,
  FrontRequest,
  PoolDeposit,
  SentEvent,
  SettledEvent,
  SettledScan,
  TriggerAuthority,
} from "../../src/payout/types";

export const ONE = 10n ** 18n;
export const TOKEN: Address = getAddress("0x54d6643762e46036b3448659791adaf554225541");
export const PAYER: Address = "0x1111111111111111111111111111111111111111";
export const OTHER_PAYER: Address = "0x2222222222222222222222222222222222222222";
export const TRIGGER_KEY: Address = "0x3333333333333333333333333333333333333333";
export const STRANGER: Address = "0x4444444444444444444444444444444444444444";
export const ACCOUNT: Hex = `0x${"ab".repeat(32)}`;
export const BRIDGE_FEE = ONE / 1000n;
export const CAP_BPS = 100;

export type LogLine = { level: "info" | "warn" | "error"; message: string; fields: Fields };

export function recordingLogger() {
  const lines: LogLine[] = [];
  const capture = (level: LogLine["level"]) => (message: string, fields: Fields = {}) => void lines.push({ level, message, fields });
  const logger: Logger = { info: capture("info"), warn: capture("warn"), error: capture("error") };
  return { logger, lines, errors: () => lines.filter((line) => line.level === "error") };
}

export class MockEthereum implements EthereumClient {
  head = 100n;
  finalized = 0n;
  authorities = new Map<Hex, TriggerAuthority>();
  authorityFailures = 0;
  private events: SentEvent[] = [];

  async blockNumber() {
    return this.head;
  }

  async finalizedBlock() {
    return this.finalized;
  }

  async sentEvents(fromBlock: bigint, toBlock: bigint) {
    return this.events.filter((event) => event.blockNumber >= fromBlock && event.blockNumber <= toBlock);
  }

  async triggerAuthority({ txHash }: Pick<SentEvent, "txHash">): Promise<TriggerAuthority> {
    if (this.authorityFailures > 0) {
      this.authorityFailures--;
      throw new Error("ethereum node unreachable");
    }
    return this.authorities.get(txHash) ?? { signer: TRIGGER_KEY, relayer: TRIGGER_KEY };
  }

  // Emits a Sent log in the current head block, signed by the trigger key unless told otherwise.
  sent(depositId: bigint, amount: bigint, overrides: Partial<SentEvent> & { signer?: Address } = {}): void {
    const { signer, ...rest } = overrides;
    const txHash: Hex = `0x${depositId.toString(16).padStart(64, "0")}`;
    if (signer) this.authorities.set(rest.txHash ?? txHash, { signer, relayer: TRIGGER_KEY });
    this.events.push({ depositId, account: ACCOUNT, token: TOKEN, amount, blockNumber: this.head, txHash, ...rest });
  }

  mine(blocks: number): void {
    this.head += BigInt(blocks);
  }
}

export class MockAssetHub implements AssetHubClient {
  readonly payer = PAYER;
  head = 500;
  funds_ = 10_000n * ONE;
  onChain = new Map<bigint, PoolDeposit>();
  frontCalls: FrontRequest[] = [];
  depositQueries: DepositKey[] = [];
  frontOutcome: FrontOutcome = { kind: "included", blockHash: `0x${"cd".repeat(32)}`, extrinsicHash: `0x${"ef".repeat(32)}` };
  failures: { deposit: number; front: number; frontAfterApply: number; blockNumber: number } = { deposit: 0, front: 0, frontAfterApply: 0, blockNumber: 0 };
  failWith: Error | undefined;
  hangFront = false;
  prunedBlocks: number[] = [];
  onFront: ((request: FrontRequest) => void) | undefined;
  private settled: SettledEvent[] = [];

  async poolParams() {
    return { bridgeFee: BRIDGE_FEE, capBps: CAP_BPS };
  }

  async blockNumber() {
    if (this.failures.blockNumber > 0) {
      this.failures.blockNumber--;
      throw new Error("ws connection lost");
    }
    return this.head;
  }

  async deposit(key: DepositKey): Promise<PoolDeposit> {
    const { depositId } = key;
    this.depositQueries.push(key);
    if (this.failures.deposit > 0) {
      this.failures.deposit--;
      throw this.failWith ?? new Error("ws connection lost");
    }
    return this.onChain.get(depositId) ?? { status: DepositStatus.None, payer: "0x0000000000000000000000000000000000000000" };
  }

  async funds() {
    return this.funds_;
  }

  async front(request: FrontRequest, signal?: AbortSignal): Promise<FrontOutcome> {
    this.frontCalls.push(request);
    this.onFront?.(request);
    if (this.hangFront) {
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("front aborted"))));
    }
    if (this.failures.front > 0) {
      this.failures.front--;
      throw new Error("ws connection lost");
    }
    if (this.frontOutcome.kind === "reverted") return this.frontOutcome;
    this.onChain.set(request.depositId, { status: DepositStatus.Fronted, payer: PAYER });
    this.funds_ -= request.amount - request.fee;
    if (this.failures.frontAfterApply > 0) {
      this.failures.frontAfterApply--;
      throw new Error("ws connection lost before inclusion was reported");
    }
    return this.frontOutcome;
  }

  async settledEvents(fromBlock: number, toBlock: number): Promise<SettledScan> {
    const inRange = (block: number) => block >= fromBlock && block <= toBlock;
    return { events: this.settled.filter((event) => inRange(event.blockNumber)), prunedBlocks: this.prunedBlocks.filter(inRange) };
  }

  // Settles the deposit on chain, as the router's message would, in the next block or in `block`.
  settle(depositId: bigint, repaid: boolean, amount: bigint, block?: number, to?: Address): void {
    this.head = block ?? this.head + 1;
    const payer = onChainPayer(this.onChain.get(depositId));
    this.onChain.set(depositId, { status: DepositStatus.Settled, payer });
    const recipient = to ?? (repaid ? PAYER : "0x0000000000000000000000000000000000000000");
    this.settled.push({ depositId, repaid, to: recipient, amount, blockNumber: this.head, blockHash: `0x${"aa".repeat(32)}` });
  }
}

function onChainPayer(deposit: PoolDeposit | undefined): Address {
  return deposit?.payer ?? "0x0000000000000000000000000000000000000000";
}

export const defaultOptions: ServiceOptions = {
  token: TOKEN,
  confirmations: 2,
  frontFeeBps: 10,
  maxPerDeposit: 1_000n * ONE,
  maxOutstanding: 5_000n * ONE,
  startBlock: 100n,
  pollIntervalMs: 10,
  maxAttempts: 3,
  retryDelayMs: 0,
  failedRetryMs: 60_000,
  unsettledAlertMinutes: 0,
};

export async function startService(
  overrides: Partial<ServiceOptions> = {},
  store = new PayoutStore(),
  heads: { ethereum?: bigint; assetHub?: number } = {},
  clock?: () => number,
) {
  const ethereum = new MockEthereum();
  const assetHub = new MockAssetHub();
  ethereum.head = heads.ethereum ?? ethereum.head;
  assetHub.head = heads.assetHub ?? assetHub.head;
  const log = recordingLogger();
  const options = { ...defaultOptions, ...overrides };
  const service = await PayoutService.create(options, store, ethereum, assetHub, log.logger, clock);
  return { service, store, ethereum, assetHub, log, options };
}

// Emits a deposit in the head block and mines until it has the required confirmations.
export function confirmedDeposit(ethereum: MockEthereum, depositId: bigint, amount: bigint, confirmations = 2): void {
  ethereum.sent(depositId, amount);
  ethereum.mine(confirmations);
}
