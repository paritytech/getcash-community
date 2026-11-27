import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Address, Hex } from "viem";

export type DepositStatus = "queued" | "fronted" | "repaid" | "unrepaid" | "skipped" | "reverted" | "failed";

export type DepositRecord = {
  depositId: string;
  account: Hex;
  token: Address;
  amount: string;
  ethBlock: string;
  ethTx: Hex;
  seenAt: string;
  status: DepositStatus;
  attempts: number;
  nextAttemptAt?: number;
  reason?: string;
  fee?: string;
  payout?: string;
  frontedAt?: string;
  front?: { blockHash: Hex; extrinsicHash: Hex };
  // Set once the Ethereum block of the deposit is finalized; the unsettled alert counts from here.
  finalizedAt?: number;
  alertedAt?: number;
  // `block` and `blockHash` are missing when the settlement was read from pool state after its event was pruned.
  settled?: { repaid: boolean; to: Address; amount: string; block?: number; blockHash?: Hex };
};

type State = {
  ethereumCursor?: string;
  assetHubCursor?: number;
  needsReconcile?: boolean;
  deposits: Record<string, DepositRecord>;
};

export class PayoutStore {
  private state: State = { deposits: {} };

  constructor(private readonly path?: string) {
    if (path && existsSync(path)) this.state = JSON.parse(readFileSync(path, "utf8")) as State;
  }

  get ethereumCursor(): bigint | undefined {
    return this.state.ethereumCursor === undefined ? undefined : BigInt(this.state.ethereumCursor);
  }

  setEthereumCursor(block: bigint): void {
    this.state.ethereumCursor = block.toString();
    this.save();
  }

  get assetHubCursor(): number | undefined {
    return this.state.assetHubCursor;
  }

  setAssetHubCursor(block: number): void {
    this.state.assetHubCursor = block;
    this.save();
  }

  // Set when settlement events were lost to pruning, until every fronted record has been checked against pool state.
  get needsReconcile(): boolean {
    return this.state.needsReconcile === true;
  }

  setNeedsReconcile(value: boolean): void {
    this.state.needsReconcile = value;
    this.save();
  }

  get(depositId: string): DepositRecord | undefined {
    return this.state.deposits[depositId];
  }

  list(): DepositRecord[] {
    return Object.values(this.state.deposits);
  }

  add(record: DepositRecord): boolean {
    if (this.state.deposits[record.depositId]) return false;
    this.state.deposits[record.depositId] = record;
    this.save();
    return true;
  }

  update(depositId: string, patch: Partial<DepositRecord>): DepositRecord {
    const current = this.state.deposits[depositId];
    if (!current) throw new Error(`unknown deposit ${depositId}`);
    const next = { ...current, ...patch };
    this.state.deposits[depositId] = next;
    this.save();
    return next;
  }

  private save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state, null, 2));
    renameSync(temp, this.path);
  }
}
