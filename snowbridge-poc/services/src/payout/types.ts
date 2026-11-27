import type { Address, Hex } from "viem";

export type SentEvent = {
  depositId: bigint;
  account: Hex;
  token: Address;
  amount: bigint;
  blockNumber: bigint;
  txHash: Hex;
};

export type TriggerAuthority = {
  signer: Address;
  // The registry's relayer when the transaction started, not now.
  relayer: Address;
};

export interface EthereumClient {
  blockNumber(): Promise<bigint>;
  finalizedBlock(): Promise<bigint>;
  sentEvents(fromBlock: bigint, toBlock: bigint): Promise<SentEvent[]>;
  // Throws when the signer or the relayer of that moment cannot be established, so an unverified deposit is never treated as ours.
  triggerAuthority(sent: Pick<SentEvent, "txHash" | "blockNumber">): Promise<TriggerAuthority>;
}

export type PoolParams = { bridgeFee: bigint; capBps: number };

export type DepositKey = { depositId: bigint; account: Hex; token: Address; amount: bigint };

// `status` is the pool's 0 none, 1 fronted, 2 settled.
export type PoolDeposit = { status: number; payer: Address };

export type FrontRequest = { depositId: bigint; account: Hex; token: Address; amount: bigint; fee: bigint };

export type FrontOutcome =
  | { kind: "included"; blockHash: Hex; extrinsicHash: Hex }
  // `error` is the name of the pool's custom error when the revert data decodes to one.
  | { kind: "reverted"; reason: string; error?: string };

export type SettledEvent = {
  depositId: bigint;
  repaid: boolean;
  to: Address;
  amount: bigint;
  blockNumber: number;
  blockHash: Hex;
};

// `prunedBlocks` are blocks whose events the node no longer has.
export type SettledScan = { events: SettledEvent[]; prunedBlocks: number[] };

// Every method throws on a transport or node failure; a contract revert is reported through `FrontOutcome`.
export interface AssetHubClient {
  // The payer's H160, as the pool sees it in `msg.sender`.
  readonly payer: Address;
  poolParams(): Promise<PoolParams>;
  // The newest block whose events `settledEvents` may read; the real client returns the finalized head.
  blockNumber(): Promise<number>;
  // The state of exactly this deposit (id, account, token, amount) in the pool.
  deposit(key: DepositKey): Promise<PoolDeposit>;
  funds(token: Address): Promise<bigint>;
  // Aborting `signal` ends the wait for inclusion; the extrinsic may still land.
  front(request: FrontRequest, signal?: AbortSignal): Promise<FrontOutcome>;
  settledEvents(fromBlock: number, toBlock: number): Promise<SettledScan>;
}
