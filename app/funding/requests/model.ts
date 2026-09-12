// The request record: the one shape a request is stored and reasoned about in, the observations
// that move it, and the constants the store and the reducer share.

import type {
  FailureKind,
  FailureStep,
  PaymentPhase,
  PaymentState,
  RefundProgress,
  SwapProgress,
  SwapStatusResult,
} from "@getsome/core";
import type { FundingStep } from "@getsome/funding";
import type { RequestRef } from "../../utils/request-index";
import type { FundingProgressSnapshot } from "../progress";
import { CRYPTO_SOURCE_ID, isMeldSourceId, meldMethodFor } from "../source-ids";

/** Trailing debounce per key for non-critical host writes. */
export const COALESCE_MS = 250;
/** A non-terminal record's confirmation decays after this. */
export const CONFIRMED_TTL_MS = 60_000;
/** Hidden longer than this resets the session epoch on return. */
export const HIDDEN_RESET_MS = 5_000;
/** Worker job blob poll while visible and any record is at rank 0–3. */
export const JOB_POLL_MS = 6_000;
/** Foreground Meld status poll. */
export const MELD_POLL_MS = 3_000;
/** A job whose `lastTickAt` is older than this counts as stale. */
export const WORKER_STALE_MS = 30_000;
/** Wait for the worker heartbeat before a hand-off. */
export const WORKER_READY_MS = 20_000;
/** Settled records kept in the mirror, most recent first. */
export const MIRROR_SETTLED_LIMIT = 50;
/** Bound on the reads a cancel performs before acting. */
export const CANCEL_CONFIRM_MS = 8_000;
/** A cancelled record is reaped after its deadline plus this grace. */
export const TOMBSTONE_GRACE_MS = 86_400_000;
/** Route fallback when the rail gives no deposit expiry. */
export const DEFAULT_DEPOSIT_WINDOW_MS = 86_400_000;
/** A probed-empty gap number is re-read at most this often. */
export const PROBED_RECHECK_MS = 86_400_000;
/** A chain-provisional deposit-seen may revert after this. */
export const PROVISIONAL_REVERT_MS = 600_000;
/** Failure reason for a request whose deposit window lapsed. */
export const DEPOSIT_EXPIRED_REASON = "Channel expired";

export type RequestKey = string;
export type Kind = "top-up";
/** The pipeline's steps between the deposit and the claim, derived from `FundingStep`. */
export type ConvertingStep = Exclude<FundingStep, "await-native" | "done">;
export type DepositSeenVia = "worker" | "chain" | "rail" | "core" | "faucet";

/** The converting steps in pipeline order. The `satisfies` fails to compile when `FundingStep`
 *  gains or loses a step, so the order can never drift from the type. */
export const CONVERTING_STEP_ORDER = { swap: 0, xcm: 1, "await-arrival": 2 } satisfies Record<
  ConvertingStep,
  number
>;

export const isConvertingStep = (step: string): step is ConvertingStep =>
  Object.hasOwn(CONVERTING_STEP_ORDER, step);

export type RequestStatus =
  | { kind: "awaiting-deposit" }
  | {
      kind: "deposit-seen";
      at: number;
      assurance: "provisional" | "finalized";
      via: DepositSeenVia;
    }
  | { kind: "converting"; at: number; step: ConvertingStep }
  | { kind: "claiming"; at: number }
  | { kind: "settled"; at: number }
  | { kind: "failed"; at: number; recoverable: boolean }
  | { kind: "expired"; at: number }
  | { kind: "cancelled"; at: number };

export interface RailState {
  provider: "chainflip" | "meld" | "manual";
  status: SwapProgress | "failed";
  stage: "waiting" | "received" | "processing" | "delivered" | "failed";
  delayed?: boolean;
  failure?: { kind: FailureKind; message: string };
  updatedAt: number;
}

export interface RequestFailure {
  kind: FailureKind;
  step: FailureStep;
  message: string;
  recoverable: boolean;
  refunded?: boolean;
  refund?: RefundProgress;
}

/** The object `runFundingViaWorker` sends today, verbatim. */
export interface WorkerHandoffPayload {
  label: string;
  burnerAddress: string;
  depositExpiresAt: number;
  settleAmount: string;
  underlyingAssetId: number;
  peopleParaId: number;
  assetHubGenesis: string;
  peopleGenesis: string;
  remoteFeeBuffer: string;
  keepNativeForFees: string;
}

/** What the store extracts from one job in the worker's blob. */
export interface WorkerJobView {
  phase: string;
  done: boolean;
  failure?: string;
  lastError?: string;
  fundsSeenAt: number | null;
  lastTickAt: number | null;
  claim: { phase: "claiming" | "claimed"; amount?: string; at: number } | null;
  /** As the worker records them on either branch. */
  txs?: { call: "swap" | "xcm"; txHash: string; block?: number }[];
}

export interface RequestRecord {
  schema: 2;
  kind: Kind;
  ref: RequestRef;
  rev: number;
  updatedAt: number;
  // Legacy fields, kept and still written; names and meanings as in today's ActiveFlowRecord.
  startedAt: number;
  amountHuman: string;
  chain: string;
  asset: string;
  sourceAmount?: string;
  sourceSymbol?: string;
  sourceFee?: string;
  sourceNetworkFee?: string;
  meldCountry?: string;
  meldFundingRequestId?: string;
  meldSubmittedAt?: number;
  depositAddress?: string;
  depositExpiresAt?: number;
  funded?: number;
  settledAt?: number;
  claimed?: string;
  cancelledAt?: number;
  failureReason?: string;
  refunded?: boolean;
  tradeN?: number;
  sourceId?: string;
  progress: FundingProgressSnapshot;
  // Additive fields.
  route: "crypto" | "card" | "bank";
  deposit?: {
    address: string;
    amount: string;
    formatted: string;
    assetSymbol: string;
    expiresAt: number;
  };
  deadline: { depositExpiresAt: number | null; source: "rail" | "route" };
  handoff?: WorkerHandoffPayload;
  refundAddress?: string;
  status: RequestStatus;
  rail: RailState;
  failure?: RequestFailure;
  witnesses: {
    core?: { phase: PaymentPhase; at: number };
    worker?:
      | {
          known: true;
          phase: string;
          done: boolean;
          claimPhase?: "claiming" | "claimed";
          fundsSeenAt: number | null;
          lastTickAt: number | null;
          failure?: string;
          at: number;
          txs?: WorkerJobView["txs"];
        }
      | { known: false; at: number };
    provider?: { status: string; at: number };
    chain?: {
      best?: { burnerNative: string; block?: number; at: number };
      finalized?: { burnerNative: string; block?: number; at: number };
    };
    clock?: { at: number };
    conflict?: { source: "worker" | "chain" | "core"; note: string; at: number };
  };
  confirmedAt?: number;
}

export type Observation =
  | { source: "core"; at: number; state: PaymentState }
  | { source: "core"; at: number; claim: { stage: "prompted" | "crediting"; claimed?: string } }
  /** `job: null` means the worker has no job for the request. */
  | { source: "worker"; at: number; job: WorkerJobView | null }
  | {
      source: "provider";
      at: number;
      provider: "meld" | "chainflip";
      result: SwapStatusResult;
      delayed?: boolean;
    }
  | { source: "provider"; at: number; provider: "meld"; unreachable: true }
  | { source: "provider"; at: number; provider: "meld"; gone: true; message: string }
  | {
      source: "chain";
      at: number;
      burnerNative: string;
      finality: "best" | "finalized";
      block?: number;
      via: "probe" | "pre-cancel" | "faucet";
    }
  | { source: "clock"; at: number }
  | { source: "user"; at: number; event: "cancelled"; depositExpiresAt: number }
  | { source: "user"; at: number; event: "retry" }
  | { source: "user"; at: number; event: "meld-submitted" };

/** The source a request runs under: a bare legacy ref means the crypto rail's. */
export const effectiveSourceId = (ref: RequestRef): string => ref.sourceId ?? CRYPTO_SOURCE_ID;

export const routeOf = (sourceId: string): RequestRecord["route"] =>
  isMeldSourceId(sourceId) ? meldMethodFor(sourceId) : "crypto";

/** The rail a source runs on: Meld for a fiat source, the manual deposit for the crypto rail's
 *  own source, Chainflip for every other coin. */
export const railProviderOf = (sourceId: string): RailState["provider"] =>
  isMeldSourceId(sourceId) ? "meld" : sourceId === CRYPTO_SOURCE_ID ? "manual" : "chainflip";

let clock: () => number = Date.now;

/** Replaces the store's clock; tests pin time through it. */
export function setRequestsClock(fn: () => number): void {
  clock = fn;
}

/** The store's own time: the mirror stamp, the reconcile's clock observations, a flag's stamp. */
export const requestsNow = (): number => clock();

/** Forward progress: awaiting-deposit 0 < deposit-seen 1 < converting 2 < claiming 3 < settled 4.
 *  A side exit keeps the rank it left, encoded in `failure.step` as the leg the record left: the
 *  claim (`mint`) is 3, the conversion (`swap`) is 2, the deposit is 0. The reducer derives that
 *  step from the rank at the moment of failure, whatever leg the source's own failure named. */
export function rankOf(record: Pick<RequestRecord, "status" | "failure">): number {
  switch (record.status.kind) {
    case "awaiting-deposit":
      return 0;
    case "deposit-seen":
      return 1;
    case "converting":
      return 2;
    case "claiming":
      return 3;
    case "settled":
      return 4;
    case "failed":
    case "expired":
    case "cancelled":
      return record.failure?.step === "mint" ? 3 : record.failure?.step === "swap" ? 2 : 0;
  }
}

export const isTerminal = (status: RequestStatus): boolean => status.kind === "settled";
