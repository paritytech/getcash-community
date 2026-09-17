export const WITHDRAW_RPC = {
  start: "startWithdraw",
  status: "withdrawStatus",
  tickAll: "tickAllWithdrawals",
} as const;

export type WithdrawPhase =
  | "created"
  | "checking-balance"
  | "requesting-payment"
  | "payment-pending"
  | "awaiting-people-credit"
  | "preparing"
  | "submitting"
  | "awaiting-asset-hub-credit"
  | "done"
  | "failed"
  | "unknown";

export interface StartWithdrawInput {
  /** 32-byte payment idempotency key as 0x-prefixed hex. */
  id: string;
  /** CASH amount in 6-decimal base units. */
  amount: string;
}

export interface TickWithdrawInput {
  /** Reconcile recoverable unknown records without requesting payment or resubmitting. */
  includeUnknown?: boolean;
}

export interface WithdrawAccountView {
  label: string;
  peopleAddress: string;
  publicKeyHex: string;
}

export interface WithdrawPaymentView {
  id: string;
  requestedAmount: string;
  phase?: string;
  status?: string;
  actualClaimed?: string;
  terminalAt?: number;
  failureReason?: string;
}

export interface WithdrawSubmissionView {
  phase: string;
  attempts: number;
  at: number;
  expectedPUsd?: string;
  assetHubBalanceBefore?: string;
  txHash?: string;
  block?: number;
  ok?: boolean;
  dispatchError?: unknown;
  xcmAttempt?: unknown;
}

export interface WithdrawJobView {
  v: number;
  known: true;
  id: string;
  amount: string;
  label: string;
  phase: WithdrawPhase;
  done: boolean;
  createdAt: number;
  updatedAt: number;
  lastTickAt: number | null;
  lastError?: string;
  failure?: string;
  account?: WithdrawAccountView;
  payment?: WithdrawPaymentView;
  peopleCredit?: {
    target: string;
    balance: string;
    finalizedAt?: number;
  };
  prepared?: {
    peopleBalance: string;
    assetHubBalanceBefore: string;
    pUsdTransfer: string;
    maxPUsdSwapInput: string;
    pasToSwap: string;
  };
  submission?: WithdrawSubmissionView;
  assetHubCredit?: {
    expected: string;
    balanceBefore: string;
    balance: string;
    delta: string;
    finalizedAt?: number;
  };
}

export interface UnknownWithdrawJobView {
  known: false;
  id?: string;
  reason?: string;
}

export type WithdrawStatusView = WithdrawJobView | UnknownWithdrawJobView;
