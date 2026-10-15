// Swap-status normalization: callers see mapped states, never raw Chainflip ones.

import type {
  ChainflipFailureInfo,
  ChainflipProgressFacts,
  EgressInfo,
  SwapStatusResult,
} from "@getsome/core";

export interface StatusBackend {
  getStatusV2(args: { id: string }): Promise<unknown>;
}

const STATES = new Map<string, SwapStatusResult["status"]>([
  ["WAITING", "waiting"],
  ["RECEIVING", "receiving"],
  ["SWAPPING", "swapping"],
  ["SENDING", "sending"],
  ["SENT", "sent"],
  ["COMPLETED", "complete"],
  ["FAILED", "failed"],
]);

type Fields = Readonly<Record<string, unknown>>;

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The object's fields, or none when the value is not an object. */
const fields = (value: unknown): Fields => (isFields(value) ? value : {});

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** A timestamp or a duration. */
const time = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function failureOf(value: unknown): ChainflipFailureInfo | undefined {
  if (!isFields(value)) return undefined;
  const reason = isFields(value.reason)
    ? { code: text(value.reason.code), message: text(value.reason.message) }
    : undefined;
  return { mode: text(value.mode), reason, failedAt: time(value.failedAt) };
}

function egressOf(value: unknown): EgressInfo | undefined {
  if (!isFields(value)) return undefined;
  return {
    amount: text(value.amount),
    scheduledAt: time(value.scheduledAt),
    txRef: text(value.txRef),
    witnessedAt: time(value.witnessedAt),
    failure: failureOf(value.failure),
  };
}

function chunksOf(dca: Fields): ChainflipProgressFacts["chunks"] {
  const executed = count(dca.executedChunks);
  const remaining = count(dca.remainingChunks);
  return executed === undefined || remaining === undefined ? undefined : { executed, remaining };
}

function durationsOf(value: unknown): ChainflipProgressFacts["estimatedDurationsSeconds"] {
  const durations = fields(value);
  const estimates = {
    deposit: time(durations.deposit),
    swap: time(durations.swap),
    egress: time(durations.egress),
  };
  return Object.values(estimates).some((seconds) => seconds !== undefined) ? estimates : undefined;
}

function progressOf(body: Fields): ChainflipProgressFacts {
  const swap = fields(body.swap);
  const regular = fields(swap.regular);
  const dca = fields(swap.dca);
  return {
    depositConfirmations: count(fields(body.deposit).txConfirmations),
    requiredConfirmations: count(body.srcChainRequiredBlockConfirmations),
    boostedAt: time(fields(body.boost).boostedAt),
    swapScheduledAt: time(regular.scheduledAt),
    chunks: chunksOf(dca),
    swapRescheduledAt:
      time(regular.latestSwapRescheduledAt) ??
      time(fields(dca.currentChunk).latestSwapRescheduledAt),
    estimatedDurationsSeconds: durationsOf(body.estimatedDurationsSeconds),
    lastStatechainUpdateAt: time(body.lastStatechainUpdateAt),
  };
}

/**
 * Fetch and normalize a swap's status by deposit channel id (e.g. "123-Bitcoin-45"). An unknown
 * or missing state reads as waiting; a malformed field reads as absent.
 */
export async function getSwapStatus(
  backend: StatusBackend,
  depositChannelId: string,
): Promise<SwapStatusResult> {
  const result = await backend.getStatusV2({ id: depositChannelId });
  const body = fields(result);

  return {
    status: STATES.get(text(body.state) ?? "") ?? "waiting",
    // The successful egress lifecycle (amount/txRef/witnessedAt): deliver-mode's receipt source.
    egress: egressOf(body.swapEgress),
    // Deposit rejected by Chainflip (BelowMinimumDeposit, NotEnoughToPayFees, ...); funds are not
    // recoverable.
    depositFailure: failureOf(fields(body.deposit).failure),
    // Swap egress (DOT to Asset Hub) failed.
    swapEgressFailure: failureOf(fields(body.swapEgress).failure),
    // Chainflip routed funds to a fallback chain; funds are not on Asset Hub.
    fallbackEgress: egressOf(body.fallbackEgress),
    // Refund egress states once status === 'failed' (slippage-violation path).
    refundEgress: egressOf(body.refundEgress),
    progress: progressOf(body),
    raw: result,
  };
}

/**
 * True when depositFailure, swapEgressFailure or fallbackEgress is present; the SDK leaves the
 * top-level state on its happy-path value for these.
 */
export function isImplicitFailure(result: SwapStatusResult): boolean {
  return !!result.depositFailure || !!result.swapEgressFailure || !!result.fallbackEgress;
}
