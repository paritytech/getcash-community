// The requests store: every request record in one map, moved only by the reducer, mirrored to
// Web Storage on every change and persisted to the host store beneath. The worker's job blob is
// read here and nowhere else.

import { defineStore } from "pinia";
import { computed, ref, shallowRef, watch } from "vue";
import type { FlowState, SourceId } from "@getsome/core";
import { createMeldClient, getMeldStatus, type MeldClientLike } from "@getsome/meld";
import {
  advanceFundingProgressSnapshot,
  createFundingProgressSnapshot,
  progressProviderForSource,
  type FundingProgressSnapshot,
} from "../funding/progress";
import { depositWindowFor } from "../funding/config";
import { migrateRecord } from "../funding/requests/migrate";
import {
  CANCEL_CONFIRM_MS,
  COALESCE_MS,
  DEPOSIT_EXPIRED_REASON,
  HIDDEN_RESET_MS,
  JOB_POLL_MS,
  MELD_POLL_MS,
  MIRROR_SETTLED_LIMIT,
  PAYMENT_POLL_MS,
  PAYMENT_WINDOW_MS,
  PROBED_RECHECK_MS,
  TOMBSTONE_GRACE_MS,
  WORKER_READY_MS,
  WORKER_STALE_MS,
  buyerPaid,
  effectiveSourceId,
  isFinished,
  isTopUp,
  isWithdrawSourceId,
  isWithdrawal,
  paymentTaken,
  railProviderOf,
  rankOf,
  requestsNow,
  routeOf,
  type Freshness,
  type HostPaymentStatus,
  type Observation,
  type RequestKey,
  type RequestRecord,
  type TopUpRecord,
  type WithdrawJobView,
  type WithdrawalHandoffPayload,
  type WithdrawalRecord,
  type WorkerHandoffPayload,
  type WorkerJobView,
} from "../funding/requests/model";
import { paymentIdFor } from "../funding/requests/payment-id";
import { reduce } from "../funding/requests/reducer";
import {
  createMemoryKeyedStorage,
  getRecordStorage,
  PROBED_KEY,
  readMirrorSync,
  REQUEST_INDEX_KEY,
  requestKey,
  setMirrorStorage,
  setRecordStorage,
  WITHDRAW_JOBS_KEY,
  WORKER_JOBS_KEY,
  writeMirrorSync,
  type KeyedStorage,
} from "../funding/requests/storage";
import {
  claimingOf,
  freshnessOf,
  fundingStepOf,
  fundsSeenOf,
  journeyScaleOf,
  journeyStepsOf,
  meldHandedOffOf,
  meldStageOf,
  milestonesOf,
  phaseLike,
} from "../funding/requests/views";
import { CRYPTO_SOURCE_ID, MELD_SOURCE_IDS } from "../funding/source-ids";
import { fmtCash, toCashBase } from "../utils/cash";
import {
  parseRequestIndex,
  parseRequestRefKey,
  requestRefKey,
  requestRefOf,
  sameRequestRef,
  serializeRequestIndex,
  type RequestRef,
} from "../utils/request-index";
import { sendHandoff, workerSessionId } from "~~/lib/coinage";
import { SOURCE_CHAINS, sourceIdFor } from "~~/lib/config";
import { isHosted } from "~~/lib/host-account";

export interface RequestEntry {
  record: RequestRecord;
  /** The last host write's failure; cleared by the next successful write. */
  persistError?: string;
  /** The last host read's failure; cleared by the next successful read. */
  readError?: string;
  /** The last hand-off's failure, a send or a build; cleared by the next successful send. */
  handoffError?: string;
  /** The memory record is ahead of the host store. */
  pendingWrite: boolean;
}

/** What the lifecycle listeners need of `document`; tests pass a fake. */
export type DocumentLike = {
  visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};
/** What the lifecycle listeners need of `window`; tests pass a fake. */
export type WindowLike = {
  addEventListener(
    type: "pagehide" | "pageshow",
    listener: (event: { persisted?: boolean }) => void,
  ): void;
  removeEventListener(
    type: "pagehide" | "pageshow",
    listener: (event: { persisted?: boolean }) => void,
  ): void;
};

/** How many records a reconcile reads at once. */
const READ_PARALLELISM = 4;
/** How many burners a reconcile reads at once. */
const CHAIN_READ_PARALLELISM = 4;
/** How many provider statuses a reconcile reads at once. */
const MELD_READ_PARALLELISM = 2;
/** Bound on one chain read in a reconcile: today's `step` bound on the tombstone probe. */
const PROBE_BOUND_MS = 15_000;

/** The hand-off's own message for a worker that never came up, noted on every entry a pass
 *  could not send for. */
const WORKER_NOT_RUNNING =
  "the funding worker is not running on this host; the purchase cannot start";

/** Today's message for a payment the adapter no longer knows; a 404 never self-heals. */
const MELD_GONE_MESSAGE =
  "We can no longer find this payment. Do not pay again. Contact support with your reference.";
/** Consecutive "not found" answers before a payment is declared gone: one 404 can be an adapter restart. */
const MELD_GONE_AFTER = 3;

/** The demo deck entered its sandbox this session; a reload leaves it. */
let sandboxEntered = false;

// The client the background Meld reads go through: the adapter named by `VITE_MELD_BASE_URL`,
// built once; null when this build has no adapter, and the reads are skipped.
let defaultMeldStatusClient: MeldClientLike | null | undefined;
function defaultMeldStatusClientFactory(): MeldClientLike | null {
  if (defaultMeldStatusClient === undefined) {
    const baseUrl = import.meta.env.VITE_MELD_BASE_URL as string | undefined;
    defaultMeldStatusClient = baseUrl
      ? createMeldClient({
          baseUrl,
          productId: (import.meta.env.VITE_MELD_PRODUCT_ID as string | undefined) ?? "getcash.dev",
        })
      : null;
  }
  return defaultMeldStatusClient;
}
let meldStatusClientFactory: () => MeldClientLike | null = defaultMeldStatusClientFactory;

/** Makes the background Meld reads go through the client `factory` returns; tests inject a fake. */
export function setMeldStatusClientFactory(factory: () => MeldClientLike | null): void {
  meldStatusClientFactory = factory;
}

/** What `getsome:probed` holds per source and trade number: when its empty burner was first and
 *  last read, and whether the read found funds nothing else knew of. */
interface ProbedNumber {
  firstAt: number;
  lastAt: number;
  funded?: true;
}
type ProbedBySource = Record<string, Record<string, ProbedNumber>>;

/** The stored shape is `{ schema: 1, [sourceId]: { [tradeN]: ProbedNumber } }`; anything else
 *  reads as nothing probed. */
function parseProbed(raw: string | null): ProbedBySource {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const { schema, ...sources } = parsed as { schema?: unknown } & ProbedBySource;
  return schema === 1 ? sources : {};
}

const serializeProbed = (sources: ProbedBySource): string =>
  JSON.stringify({ schema: 1, ...sources });

/** The status kinds whose arrival is written to the host before `observe` resolves. */
const CRITICAL_KINDS = new Set<RequestRecord["status"]["kind"]>([
  "deposit-seen",
  "settled",
  "cancelled",
  "failed",
  "expired",
  "paid",
  "sent",
]);

/** A critical change is written to the host before `observe` resolves: the money's first
 *  sighting (a worker step can carry a record from rank 0 straight to converting), a terminal or
 *  side-exit kind, a failure; for a top-up the buyer's submit; for a withdrawal the prompt's
 *  stamp with its id, so a prompt that went out is on the host before the host is asked. */
function isCritical(previous: RequestRecord, next: RequestRecord): boolean {
  if (
    (rankOf(previous) === 0 && rankOf(next) >= 1) ||
    (next.status.kind !== previous.status.kind && CRITICAL_KINDS.has(next.status.kind)) ||
    (previous.failure === undefined && next.failure !== undefined)
  ) {
    return true;
  }
  if (isTopUp(previous) && isTopUp(next)) {
    return (
      (previous.meldSubmittedAt === undefined && next.meldSubmittedAt !== undefined) ||
      (previous.depositSkippedAt === undefined && next.depositSkippedAt !== undefined)
    );
  }
  if (isWithdrawal(previous) && isWithdrawal(next)) {
    return (
      previous.payment.requestedAt !== next.payment.requestedAt ||
      previous.payment.id !== next.payment.id
    );
  }
  return false;
}

/** The fields an observation changes without moving the record: per-session facts, never
 *  written on their own. A persisted witness is stale by definition. */
const WITNESS_FIELDS: ReadonlySet<string> = new Set(["witnesses", "confirmedAt", "updatedAt"]);

/** True when `next` differs from `current` in the witness fields alone. The reducer keeps every
 *  field it did not touch as the same object, so a per-field `===` is exact. */
function witnessOnly(current: RequestRecord, next: RequestRecord): boolean {
  const fields = new Set([...Object.keys(current), ...Object.keys(next)]);
  for (const field of fields) {
    if (WITNESS_FIELDS.has(field)) continue;
    if (current[field as keyof RequestRecord] !== next[field as keyof RequestRecord]) return false;
  }
  return true;
}

interface Mirror {
  schema: 2;
  writtenAt: number;
  index: RequestRef[];
  records: Record<RequestKey, unknown>;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const tradeNOf = (record: RequestRecord): number =>
  isTopUp(record) ? (record.tradeN ?? record.ref.tradeN) : record.ref.tradeN;

/** Newest first; the trade number breaks ties. Today's `readAllRequests` order. */
const newestFirst = (a: RequestRecord, b: RequestRecord): number =>
  b.startedAt - a.startedAt || tradeNOf(b) - tradeNOf(a);

/** When a finished record finished: a top-up settled, a withdrawal sent. 0 for one that has not. */
function finishedAtOf(record: RequestRecord): number {
  if (isTopUp(record)) return record.status.kind === "settled" ? record.status.at : 0;
  return record.status.kind === "sent" ? record.status.at : 0;
}

function parseMirror(raw: string): Mirror | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { schema, records } = parsed as Partial<Mirror>;
  if (schema !== 2 || typeof records !== "object" || records === null) return null;
  return parsed as Mirror;
}

/** Runs `work` over `items` with at most `limit` in flight. */
async function inParallel<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

const MINUTE = 60_000;

/** Rank 0–3 in the design's sense: a request the worker is still moving. A withdrawal at
 *  `sending` is the rail's to move, not the worker's. */
const WORKER_DRIVEN_KINDS = new Set<RequestRecord["status"]["kind"]>([
  "awaiting-deposit",
  "deposit-seen",
  "converting",
  "claiming",
  "awaiting-payment",
  "paid",
]);
const isWorkerDriven = (record: RequestRecord): boolean =>
  WORKER_DRIVEN_KINDS.has(record.status.kind);
/** Rank 0–3, or a side exit the worker's verdict can still move: failed or expired. */
const followsWorker = (record: RequestRecord): boolean =>
  isWorkerDriven(record) || record.status.kind === "failed" || record.status.kind === "expired";

/** Why the worker must be handed the request again, or null when it has the job in hand: it has
 *  no job for it (`unknown`), or it retired the job after the money was paid (`expired`): a job
 *  that expired, or a withdrawal's job cancelled while the host's sheet was still up and then
 *  approved, whose CASH reached the key after all. */
function lostHandoff(record: RequestRecord): "unknown" | "expired" | null {
  const { worker } = record.witnesses;
  if (worker === undefined || !isWorkerDriven(record)) return null;
  if (!worker.known) return "unknown";
  if (isWithdrawal(record) && worker.failure === "cancelled" && rankOf(record) >= 1) {
    return "expired";
  }
  if (worker.failure !== "expired") return null;
  const paid = isTopUp(record) ? buyerPaid(record) : paymentTaken(record);
  return paid ? "expired" : null;
}

/** What this surface reads of a worker's stored job record. */
type WorkerJob = {
  phase?: string;
  done?: boolean;
  failure?: string;
  lastError?: string;
  lastTickAt?: number | null;
  state?: { fundsSeenAt?: number | null };
  claim?: {
    phase?: string;
    amount?: string;
    credited?: string;
    status?: string;
    at?: number;
  } | null;
  txs?: WorkerJobView["txs"];
  // The hand-off the worker keeps, read back when the surface has no record of the job.
  label?: string;
  burnerAddress?: string;
  depositExpiresAt?: number | null;
  settleAmount?: string;
  underlyingAssetId?: number;
  peopleParaId?: number;
  assetHubGenesis?: string;
  peopleGenesis?: string;
  remoteFeeBuffer?: string;
  keepNativeForFees?: string;
  createdAt?: number;
  armedAt?: number;
};

/** Every worker job, keyed by workerSessionId; {} when there are none. */
async function readWorkerJobs(): Promise<Record<string, WorkerJob>> {
  try {
    const raw = await (await getRecordStorage()).read(WORKER_JOBS_KEY);
    return raw === null ? {} : (JSON.parse(raw) as Record<string, WorkerJob>);
  } catch {
    return {};
  }
}

/** The job as the record's reducer reads it. */
function jobView(job: WorkerJob): WorkerJobView {
  const { claim } = job;
  return {
    phase: job.phase ?? "",
    done: job.done === true,
    ...(job.failure === undefined ? {} : { failure: job.failure }),
    ...(job.lastError === undefined ? {} : { lastError: job.lastError }),
    fundsSeenAt: job.state?.fundsSeenAt ?? null,
    lastTickAt: job.lastTickAt ?? null,
    claim:
      claim &&
      (claim.phase === "sizing" ||
        claim.phase === "registering" ||
        claim.phase === "claiming" ||
        claim.phase === "claimed")
        ? {
            phase: claim.phase,
            ...(claim.amount === undefined ? {} : { amount: claim.amount }),
            ...(claim.credited === undefined ? {} : { credited: claim.credited }),
            ...(claim.status === undefined ? {} : { status: claim.status }),
            at: claim.at ?? job.lastTickAt ?? Date.now(),
          }
        : null,
    ...(job.txs === undefined ? {} : { txs: job.txs }),
  };
}

/** What this surface reads of a worker's stored withdrawal job. */
type WithdrawJob = {
  phase?: string;
  done?: boolean;
  failure?: string;
  lastError?: string;
  lastTickAt?: number | null;
  state?: { fundsSeenAt?: number | null };
  txs?: WithdrawJobView["txs"];
  // The hand-off the worker keeps, read back when the surface has no record of the job.
  label?: string;
  keyAddress?: string;
  keyPublicKeyHex?: string;
  amount?: string;
  destination?: { chain?: unknown; asset?: unknown; address?: unknown };
  landingHex?: string;
  rail?: string;
  assetHubGenesis?: string;
  peopleGenesis?: string;
  peopleParaId?: number;
  assetHubParaId?: number;
  poolAccount?: string;
  slippagePct?: number;
  paymentExpiresAt?: number;
  createdAt?: number;
};

/** Every withdrawal job, keyed by workerSessionId; {} when there are none. */
async function readWithdrawJobs(): Promise<Record<string, WithdrawJob>> {
  try {
    const raw = await (await getRecordStorage()).read(WITHDRAW_JOBS_KEY);
    return raw === null ? {} : (JSON.parse(raw) as Record<string, WithdrawJob>);
  } catch {
    return {};
  }
}

/** The withdrawal job as the record's reducer reads it. */
function withdrawJobView(job: WithdrawJob): WithdrawJobView {
  return {
    phase: job.phase ?? "",
    done: job.done === true,
    ...(job.failure === undefined ? {} : { failure: job.failure }),
    ...(job.lastError === undefined ? {} : { lastError: job.lastError }),
    fundsSeenAt: job.state?.fundsSeenAt ?? null,
    lastTickAt: job.lastTickAt ?? null,
    ...(job.txs === undefined ? {} : { txs: job.txs }),
  };
}

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** The ref a worker session id names (`<sourceId>:<tradeN>`), or null for anything else. */
function refOfSessionId(sessionId: string): RequestRef | null {
  const separator = sessionId.lastIndexOf(":");
  if (separator <= 0) return null;
  const tail = sessionId.slice(separator + 1);
  if (!/^\d+$/.test(tail)) return null;
  const tradeN = Number(tail);
  if (!Number.isSafeInteger(tradeN) || tradeN < 1) return null;
  return requestRefOf(sessionId.slice(0, separator), tradeN);
}

/** The rail's deposit deadline on the job, or null when the rail gave none. */
const railExpiryOf = (job: WorkerJob): number | null =>
  isNumber(job.depositExpiresAt) && job.depositExpiresAt > 0 ? job.depositExpiresAt : null;

/** Today's `lastQuoteParams` for a source id: the rail and method of a Meld source, the chain and
 *  coin of a swap source, Asset Hub's own for the crypto rail's, the id itself otherwise. */
function displaySourceOf(sourceId: string): { chain: string; asset: string } {
  const route = routeOf(sourceId);
  if (route !== "crypto") return { chain: "Meld", asset: route === "bank" ? "Bank" : "Card" };
  if (sourceId === CRYPTO_SOURCE_ID) return { chain: "AssetHub", asset: "DOT" };
  for (const { chain, assets } of SOURCE_CHAINS) {
    for (const asset of assets) {
      if (sourceIdFor(chain, asset) === sourceId) return { chain, asset };
    }
  }
  return { chain: sourceId, asset: sourceId };
}

/** The snapshot a request starts with when its record is built from the worker's job: today's
 *  defaults for the source, with no quote to size the ingress from. */
function initialProgressForSource(sourceId: string, startedAt: number): FundingProgressSnapshot {
  const route = routeOf(sourceId);
  const provider = progressProviderForSource(sourceId);
  // A card confirms within minutes; a bank transfer takes business days.
  const profile =
    route === "crypto"
      ? provider.createProfile()
      : provider.createProfile({
          ingressDurationMs: route === "bank" ? 24 * 60 * MINUTE : 5 * MINUTE,
        });
  const journeyMs =
    profile.expectedUserDelayMs +
    profile.stages.reduce((total, stage) => total + stage.nominalMs, 0);
  return createFundingProgressSnapshot(profile, {
    preDetectionEstimateText:
      route === "crypto"
        ? "≈10 min after your transfer"
        : route === "bank"
          ? "1-2 business days after you pay"
          : "≈ minutes after you pay",
    estimatedCompletionAt: startedAt + journeyMs,
  });
}

/** The hand-off the worker keeps on its job, when every field is there. */
function handoffOf(job: WorkerJob): WorkerHandoffPayload | undefined {
  const {
    label,
    burnerAddress,
    settleAmount,
    underlyingAssetId,
    peopleParaId,
    assetHubGenesis,
    peopleGenesis,
    remoteFeeBuffer,
    keepNativeForFees,
  } = job;
  if (
    !isString(label) ||
    !isString(burnerAddress) ||
    !isString(settleAmount) ||
    !isNumber(underlyingAssetId) ||
    !isNumber(peopleParaId) ||
    !isString(assetHubGenesis) ||
    !isString(peopleGenesis) ||
    !isString(remoteFeeBuffer) ||
    !isString(keepNativeForFees)
  ) {
    return undefined;
  }
  return {
    label,
    burnerAddress,
    depositExpiresAt: railExpiryOf(job) ?? 0,
    settleAmount,
    underlyingAssetId,
    peopleParaId,
    assetHubGenesis,
    peopleGenesis,
    remoteFeeBuffer,
    keepNativeForFees,
  };
}

/** The hand-off the worker keeps on its withdrawal job, when every field is there. */
function withdrawHandoffOf(job: WithdrawJob): WithdrawalHandoffPayload | undefined {
  const { destination, rail } = job;
  if (
    !isString(job.label) ||
    !isString(job.keyAddress) ||
    !isString(job.keyPublicKeyHex) ||
    !isString(job.amount) ||
    !/^\d+$/.test(job.amount) ||
    !isString(destination?.chain) ||
    !isString(destination?.asset) ||
    !isString(destination?.address) ||
    !isString(job.landingHex) ||
    (rail !== "direct" && rail !== "chainflip") ||
    !isString(job.assetHubGenesis) ||
    !isString(job.peopleGenesis) ||
    !isNumber(job.peopleParaId) ||
    !isNumber(job.assetHubParaId) ||
    !isString(job.poolAccount) ||
    !isNumber(job.slippagePct) ||
    !isNumber(job.paymentExpiresAt)
  ) {
    return undefined;
  }
  return {
    label: job.label,
    keyAddress: job.keyAddress,
    keyPublicKeyHex: job.keyPublicKeyHex,
    amount: job.amount,
    destination: {
      chain: destination.chain,
      asset: destination.asset,
      address: destination.address,
    },
    landingHex: job.landingHex,
    rail,
    assetHubGenesis: job.assetHubGenesis,
    peopleGenesis: job.peopleGenesis,
    peopleParaId: job.peopleParaId,
    assetHubParaId: job.assetHubParaId,
    poolAccount: job.poolAccount,
    slippagePct: job.slippagePct,
    paymentExpiresAt: job.paymentExpiresAt,
  };
}

/** A withdrawal record for a job the surface has no record of. The prompt happened before the
 *  hand-off, under the first attempt's id, which the key derives again: the host can be asked
 *  about it. Null when the job lacks what a record needs. */
function recordFromWithdrawJob(sessionId: string, job: WithdrawJob): WithdrawalRecord | null {
  const ref = refOfSessionId(sessionId);
  const handoff = withdrawHandoffOf(job);
  if (ref === null || handoff === undefined || !isNumber(job.createdAt)) return null;
  const startedAt = job.createdAt;
  return {
    schema: 2,
    kind: "withdrawal",
    ref,
    rev: 0,
    updatedAt: startedAt,
    startedAt,
    amountHuman: fmtCash(BigInt(handoff.amount)),
    route: "crypto",
    destination: handoff.destination,
    key: {
      label: handoff.label,
      address: handoff.keyAddress,
      publicKeyHex: handoff.keyPublicKeyHex,
    },
    payment: {
      attempt: 0,
      requestedAt: startedAt,
      id: paymentIdFor(handoff.keyPublicKeyHex, 0),
    },
    deadline: { paymentExpiresAt: handoff.paymentExpiresAt },
    handoff,
    status: { kind: "awaiting-payment" },
    rail: { provider: handoff.rail, stage: "waiting", updatedAt: startedAt },
    witnesses: {},
  };
}

/** A record for a job the surface has no record of, the "chain knows, cache does not" case; it
 *  renders with generic labels. Null when the job lacks what a record needs. */
function recordFromJob(sessionId: string, job: WorkerJob): TopUpRecord | null {
  const ref = refOfSessionId(sessionId);
  const { settleAmount, createdAt } = job;
  if (
    ref === null ||
    !isString(settleAmount) ||
    !/^\d+$/.test(settleAmount) ||
    !isNumber(createdAt)
  ) {
    return null;
  }
  const sourceId = effectiveSourceId(ref);
  const startedAt = createdAt;
  const railExpiry = railExpiryOf(job);
  // The default window counts from the arming, as the worker's own expiry does.
  const armedAt = isNumber(job.armedAt) ? job.armedAt : startedAt;
  const handoff = handoffOf(job);
  return {
    schema: 2,
    kind: "top-up",
    ref,
    rev: 0,
    updatedAt: startedAt,
    amountHuman: fmtCash(BigInt(settleAmount)),
    ...displaySourceOf(sourceId),
    startedAt,
    ...(isString(job.burnerAddress) ? { depositAddress: job.burnerAddress } : {}),
    progress: initialProgressForSource(sourceId, startedAt),
    tradeN: ref.tradeN,
    sourceId,
    ...(railExpiry === null ? {} : { depositExpiresAt: railExpiry }),
    route: routeOf(sourceId),
    deadline:
      railExpiry === null
        ? { depositExpiresAt: armedAt + depositWindowFor(routeOf(sourceId)), source: "route" }
        : { depositExpiresAt: railExpiry, source: "rail" },
    ...(handoff === undefined ? {} : { handoff }),
    status: { kind: "awaiting-deposit" },
    rail: {
      provider: railProviderOf(sourceId),
      status: "waiting",
      stage: "waiting",
      updatedAt: startedAt,
    },
    witnesses: {},
  };
}

/** A flow slot that can size a record: core wrote the settle amount into it at the start. */
const hasHandoffAmount = (slot: FlowState | null): slot is FlowState & { handoffAmount: string } =>
  slot !== null && slot.handoffAmount !== undefined;

/** A record for a funded burner the surface lost every trace of, from the core flow slot that
 *  started it: the only thing left that knows the amount. Generic labels, like a job's record. */
function recordFromFlowSlot(
  ref: RequestRef,
  address: string,
  slot: FlowState & { handoffAmount: string },
  handoff: WorkerHandoffPayload,
  now: number,
): TopUpRecord {
  const sourceId = effectiveSourceId(ref);
  const startedAt = slot.createdAt;
  const depositAddress = slot.depositAddress ?? address;
  const railExpiry = slot.depositExpiresAt ? slot.depositExpiresAt : null;
  return {
    schema: 2,
    kind: "top-up",
    ref,
    rev: 0,
    updatedAt: now,
    amountHuman: fmtCash(BigInt(slot.handoffAmount)),
    ...displaySourceOf(sourceId),
    startedAt,
    depositAddress,
    progress: initialProgressForSource(sourceId, startedAt),
    tradeN: ref.tradeN,
    sourceId,
    ...(railExpiry === null ? {} : { depositExpiresAt: railExpiry }),
    route: routeOf(sourceId),
    deposit: {
      address: depositAddress,
      amount: slot.depositAmount ?? "0",
      formatted: slot.depositFormatted ?? "",
      assetSymbol: slot.depositAssetSymbol ?? "",
      expiresAt: railExpiry ?? 0,
    },
    deadline:
      railExpiry === null
        ? { depositExpiresAt: startedAt + depositWindowFor(routeOf(sourceId)), source: "route" }
        : { depositExpiresAt: railExpiry, source: "rail" },
    handoff,
    status: { kind: "awaiting-deposit" },
    rail: {
      provider: railProviderOf(sourceId),
      status: "waiting",
      stage: "waiting",
      updatedAt: startedAt,
    },
    witnesses: {},
  };
}

export const useRequestsStore = defineStore("requests", () => {
  const entries = shallowRef<Readonly<Record<RequestKey, RequestEntry>>>({});
  /** A mirror with today's schema was read into memory. */
  const hydrated = ref(false);
  /** A reconcile has read the host's records, whatever it found. */
  const hostReadDone = ref(false);
  const storage = ref<"ok" | "unavailable">("ok");
  /** Reads before this instant no longer count as confirmation; reset on return from a long
   *  background stint. */
  const sessionEpoch = ref(requestsNow());
  /** A reconcile pass is running. */
  const reconcilingNow = ref(false);
  /** The store's second hand, advanced while the page is visible and an unfinished record
   *  exists; a settled record's freshness does not depend on time. */
  const tick = ref(requestsNow());
  /** The demo deck's sandbox: records live in memory alone and nothing outside is read or told. */
  const sandboxed = ref(false);

  const records = computed(() => Object.values(entries.value).map((entry) => entry.record));
  const open = computed(() => records.value.filter((record) => record.status.kind !== "cancelled"));
  /** The open records in list order, newest first. */
  const openRecords = computed(() => [...open.value].sort(newestFirst));
  const topUps = computed(() => records.value.filter(isTopUp));
  const openTopUps = computed(() => openRecords.value.filter(isTopUp));
  const withdrawals = computed(() => records.value.filter(isWithdrawal));
  const openWithdrawals = computed(() => openRecords.value.filter(isWithdrawal));
  const freshness = computed<Record<RequestKey, Freshness>>(() => {
    const out: Record<RequestKey, Freshness> = {};
    for (const record of records.value) {
      out[requestRefKey(record.ref)] = freshnessOf(
        record,
        tick.value,
        sessionEpoch.value,
        reconcilingNow.value,
      );
    }
    return out;
  });

  const get = (ref: RequestRef): RequestRecord | undefined =>
    entries.value[requestRefKey(ref)]?.record;
  const has = (ref: RequestRef): boolean => entries.value[requestRefKey(ref)] !== undefined;
  /** Trade `n` under `sourceId` has left a trace: a record in memory or a job in the worker's
   *  blob. A number with a trace is never given to a new request. */
  async function hasTrace(sourceId: string, n: number): Promise<boolean> {
    if (has(requestRefOf(sourceId, n))) return true;
    const jobs = isWithdrawSourceId(sourceId) ? await readWithdrawJobs() : await readWorkerJobs();
    return jobs[workerSessionId(sourceId, n)] !== undefined;
  }

  function setEntry(key: RequestKey, entry: RequestEntry): void {
    entries.value = { ...entries.value, [key]: entry };
  }
  function patchEntry(key: RequestKey, patch: (entry: RequestEntry) => RequestEntry): void {
    const entry = entries.value[key];
    if (entry !== undefined) setEntry(key, patch(entry));
  }
  function dropEntry(key: RequestKey): void {
    const { [key]: _gone, ...rest } = entries.value;
    entries.value = rest;
  }

  // One serial queue per key: reads, observations and writes of a record never interleave.
  const queues = new Map<RequestKey, Promise<unknown>>();
  function enqueue<T>(key: RequestKey, task: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    // A failed predecessor never blocks the queue.
    const run = previous.catch(() => undefined).then(task);
    queues.set(key, run);
    void run
      .finally(() => {
        if (queues.get(key) === run) queues.delete(key);
      })
      .catch(() => undefined);
    return run;
  }

  /** The open records plus the most recently finished, as one synchronous blob. */
  function writeMirror(): void {
    const all = records.value;
    const kept: Record<RequestKey, RequestRecord> = {};
    for (const record of all) {
      if (!isFinished(record)) kept[requestRefKey(record.ref)] = record;
    }
    const finished = all
      .filter(isFinished)
      .sort((a, b) => finishedAtOf(b) - finishedAtOf(a))
      .slice(0, MIRROR_SETTLED_LIMIT);
    for (const record of finished) kept[requestRefKey(record.ref)] = record;
    const mirror: Mirror = {
      schema: 2,
      writtenAt: requestsNow(),
      index: all.map((record) => record.ref),
      records: kept,
    };
    writeMirrorSync(JSON.stringify(mirror));
  }

  /** Reads the mirror into memory without touching an entry already there. */
  function hydrateFromMirror(): void {
    const raw = readMirrorSync();
    if (raw === null) return;
    const mirror = parseMirror(raw);
    if (mirror === null) return;
    const now = requestsNow();
    const next: Record<RequestKey, RequestEntry> = { ...entries.value };
    for (const [key, stored] of Object.entries(mirror.records)) {
      if (next[key] !== undefined) continue;
      const ref = parseRequestRefKey(key);
      if (ref === null) continue;
      const record = migrateRecord(stored, ref, now);
      if (record !== null) next[key] = { record, pendingWrite: false };
    }
    entries.value = next;
    hydrated.value = true;
    syncTick();
  }

  /** Writes the entry's record to the host store. False when the write failed: the entry then
   *  carries `persistError` and stays pending for the next observation or reconcile. */
  async function writeHost(key: RequestKey): Promise<boolean> {
    const entry = entries.value[key];
    if (entry === undefined || !entry.pendingWrite) return true;
    const { record } = entry;
    try {
      const store = await getRecordStorage();
      await store.write(requestKey(record.ref), JSON.stringify(record));
    } catch (e) {
      const persistError = messageOf(e);
      patchEntry(key, (current) => ({ ...current, persistError }));
      console.warn(`[requests] record write failed for ${key}: ${persistError}`);
      return false;
    }
    patchEntry(key, (current) => {
      const { persistError: _cleared, ...written } = current;
      // A change that landed during the write keeps its own pending write.
      return written.record === record ? { ...written, pendingWrite: false } : written;
    });
    return true;
  }

  // Non-critical changes reach the host after a trailing window per key; a critical one at once.
  const coalesced = new Map<RequestKey, ReturnType<typeof setTimeout>>();
  function cancelCoalesced(key: RequestKey): void {
    const timer = coalesced.get(key);
    if (timer !== undefined) clearTimeout(timer);
    coalesced.delete(key);
  }
  function scheduleWrite(key: RequestKey): void {
    cancelCoalesced(key);
    coalesced.set(
      key,
      setTimeout(() => {
        coalesced.delete(key);
        void enqueue(key, () => writeHost(key));
      }, COALESCE_MS),
    );
  }
  /** Fires every pending coalesced write now. */
  function flush(): Promise<void> {
    const keys = [...coalesced.keys()];
    for (const key of keys) cancelCoalesced(key);
    return Promise.all(keys.map((key) => enqueue(key, () => writeHost(key)))).then(() => {});
  }

  /** Replaces the entry's record: the mirror at once, the host now when the change is critical
   *  and after the coalescing window otherwise. Runs inside the key's queue. */
  async function commit(key: RequestKey, next: RequestRecord, critical: boolean): Promise<void> {
    patchEntry(key, (entry) => ({ ...entry, record: next, pendingWrite: true }));
    writeMirror();
    if (critical) {
      cancelCoalesced(key);
      await writeHost(key);
    } else {
      scheduleWrite(key);
    }
  }

  /** Adds a new record: memory and the mirror at once, then the host record and the index entry,
   *  both awaited. Throws when the key already has a record. */
  async function create(ref: RequestRef, record: RequestRecord): Promise<void> {
    const key = requestRefKey(ref);
    if (entries.value[key] !== undefined) throw new Error(`request ${key} already has a record`);
    setEntry(key, { record, pendingWrite: true });
    writeMirror();
    syncTick();
    await enqueue(key, async () => {
      if (!(await writeHost(key))) {
        throw new Error(entries.value[key]?.persistError ?? "record write failed");
      }
      await mutateIndex((current) => [...current, ref]);
    });
  }

  /** Moves a record by one observation. A key with no record is left alone. A witness-only
   *  change reaches memory alone: the rev stays, nothing is written. */
  function observe(ref: RequestRef, observation: Observation): Promise<void> {
    const key = requestRefKey(ref);
    if (entries.value[key] === undefined) return Promise.resolve();
    return enqueue(key, async () => {
      const entry = entries.value[key];
      if (entry === undefined) return;
      const reduced = reduce(entry.record, observation);
      if (reduced === entry.record) return;
      if (witnessOnly(entry.record, reduced)) {
        patchEntry(key, (current) => ({ ...current, record: reduced }));
        return;
      }
      const next = { ...reduced, rev: entry.record.rev + 1 };
      await commit(key, next, isCritical(entry.record, next));
    });
  }

  /** Notes on a top-up's record something no observation carries: the core slot it expects is
   *  gone. A withdrawal has no core slot and is left alone. */
  function flag(ref: RequestRef, note: string): Promise<void> {
    const key = requestRefKey(ref);
    if (entries.value[key] === undefined) return Promise.resolve();
    return enqueue(key, async () => {
      const entry = entries.value[key];
      if (entry === undefined || !isTopUp(entry.record)) return;
      const { record } = entry;
      const conflict = { source: "core" as const, note, at: requestsNow() };
      const witnesses = { ...record.witnesses, conflict };
      await commit(key, { ...record, rev: record.rev + 1, witnesses }, false);
    });
  }

  /** Stores the hand-off a legacy record was started without, so no later re-send needs a world.
   *  Observation-free, like `flag`. */
  function setHandoff(ref: RequestRef, handoff: WorkerHandoffPayload): Promise<void> {
    const key = requestRefKey(ref);
    if (entries.value[key] === undefined) return Promise.resolve();
    return enqueue(key, async () => {
      const entry = entries.value[key];
      if (entry === undefined || !isTopUp(entry.record)) return;
      const { record } = entry;
      await commit(key, { ...record, rev: record.rev + 1, handoff }, false);
    });
  }

  /** Deletes the record from the host store, memory and the index: the tombstone reap's only
   *  deletion. */
  function remove(ref: RequestRef): Promise<void> {
    const key = requestRefKey(ref);
    return enqueue(key, async () => {
      cancelCoalesced(key);
      const store = await getRecordStorage();
      await store.clear(requestKey(ref));
      dropEntry(key);
      writeMirror();
      syncTick();
      await mutateIndex((current) => current.filter((r) => !sameRequestRef(r, ref)));
    });
  }

  /** Every index change runs here, one at a time: read, change, write. */
  let indexLock: Promise<unknown> = Promise.resolve();
  function mutateIndex(change: (current: RequestRef[]) => RequestRef[]): Promise<void> {
    const run = async () => {
      const store = await getRecordStorage();
      const current = parseRequestIndex(await store.read(REQUEST_INDEX_KEY));
      await store.write(REQUEST_INDEX_KEY, serializeRequestIndex(change(current)));
    };
    // A failed change must not wedge the chain: the next one runs regardless.
    const next = indexLock.then(run, run);
    indexLock = next.catch(() => {});
    return next;
  }

  /** The worker's job for a record, as the record's reducer reads it: the funding blob for a
   *  top-up, the withdrawal blob for a withdrawal. */
  function jobObservation(
    record: RequestRecord,
    blobs: WorkerBlobs,
    sessionId: string,
    now: number,
  ): Observation {
    if (isTopUp(record)) {
      const job = blobs.jobs[sessionId];
      return { source: "worker", at: now, job: job ? jobView(job) : null };
    }
    const job = blobs.withdrawJobs[sessionId];
    return { source: "worker", at: now, withdrawJob: job ? withdrawJobView(job) : null };
  }

  type WorkerBlobs = { jobs: Record<string, WorkerJob>; withdrawJobs: Record<string, WithdrawJob> };

  /** Reconcile step 2, and the poll's tick: one read of each of the worker's blobs; every record
   *  the worker can still move observes its job (`known: false` without one), and a job with no
   *  record gets one, created from the job and then observed with it. Returns the jobs read, so
   *  the chain step works from the same blobs. */
  async function observeWorkerJobs(now: number): Promise<WorkerBlobs> {
    const [jobs, withdrawJobs] = await Promise.all([readWorkerJobs(), readWithdrawJobs()]);
    const blobs: WorkerBlobs = { jobs, withdrawJobs };
    const known = new Set<string>();
    const observed: Promise<void>[] = [];
    for (const record of records.value) {
      const { ref } = record;
      const sessionId = workerSessionId(effectiveSourceId(ref), ref.tradeN);
      known.add(sessionId);
      if (!followsWorker(record)) continue;
      observed.push(observe(ref, jobObservation(record, blobs, sessionId, now)));
    }
    const adopt = (sessionId: string, record: RequestRecord): void => {
      observed.push(
        create(record.ref, record)
          .then(() => observe(record.ref, jobObservation(record, blobs, sessionId, now)))
          .catch((e: unknown) => {
            console.warn(`[requests] record for worker job ${sessionId} failed: ${messageOf(e)}`);
          }),
      );
    };
    for (const [sessionId, job] of Object.entries(jobs)) {
      // A cancelled request whose record is gone must not come back as a pending row.
      if (!job || known.has(sessionId) || job.failure === "cancelled") continue;
      const record = recordFromJob(sessionId, job);
      if (record !== null) adopt(sessionId, record);
    }
    for (const [sessionId, job] of Object.entries(withdrawJobs)) {
      if (!job || known.has(sessionId) || job.failure === "cancelled") continue;
      const record = recordFromWithdrawJob(sessionId, job);
      if (record !== null) adopt(sessionId, record);
    }
    await Promise.all(observed);
    return blobs;
  }

  /** The key of the request on screen. Its own world hands it to the worker; the hand-off step
   *  leaves it alone. */
  const foreground = ref<RequestKey | null>(null);
  const foregroundEntry = computed<RequestEntry | null>(() =>
    foreground.value === null ? null : (entries.value[foreground.value] ?? null),
  );
  /** The top-up on screen; null when the foreground is a withdrawal or nothing. The on-ramp's
   *  screens read their views from it. */
  const foregroundRecord = computed<TopUpRecord | null>(() => {
    const record = foregroundEntry.value?.record;
    return record !== undefined && isTopUp(record) ? record : null;
  });
  /** The withdrawal on screen; null when the foreground is a top-up or nothing. */
  const foregroundWithdrawal = computed<WithdrawalRecord | null>(() => {
    const record = foregroundEntry.value?.record;
    return record !== undefined && isWithdrawal(record) ? record : null;
  });
  function setForeground(ref: RequestRef | null): void {
    foreground.value = ref === null ? null : requestRefKey(ref);
  }

  /** A failure the record cannot carry: a hand-off the worker refused, or a faucet transfer that
   *  failed, write nothing to the record, yet the screen shows them. Only the refused hand-off
   *  also marks the progress failed. Cleared when a drive starts and when the foreground leaves. */
  const transientError = ref<{
    message: string;
    at: number;
    source: "handoff" | "faucet";
  } | null>(null);
  function setTransientError(
    value: { message: string; at: number; source: "handoff" | "faucet" } | null,
  ): void {
    transientError.value = value;
  }
  /** A line about the request on screen the record does not carry (a reconnect, a retry). */
  const fundingNotice = ref<string | null>(null);

  // What the screens read of the request on screen, all derived from its record.
  const phase = computed(() => (foregroundRecord.value ? phaseLike(foregroundRecord.value) : null));
  /** Whether a deposit has been seen for the request on screen. */
  const fundsSeen = computed(() =>
    foregroundRecord.value ? fundsSeenOf(foregroundRecord.value) : false,
  );
  const fundingStep = computed(() =>
    foregroundRecord.value ? fundingStepOf(foregroundRecord.value) : null,
  );
  const fundingError = computed(
    () =>
      transientError.value?.message ??
      foregroundRecord.value?.failure?.message ??
      (foregroundRecord.value?.status.kind === "expired" ? DEPOSIT_EXPIRED_REASON : null),
  );
  const claimStage = computed<"prompted" | "crediting" | null>(() => {
    const record = foregroundRecord.value;
    if (record?.status.kind !== "claiming") return null;
    return record.claimed !== undefined ? "crediting" : "prompted";
  });
  /** The claimed amount; a full burner sweep, so it may exceed the typed amount. */
  const claimedBase = computed(() => {
    const claimed = foregroundRecord.value?.claimed;
    return claimed === undefined ? null : BigInt(claimed);
  });
  /** When each journey step landed, in ms since epoch, by step number. */
  const milestones = computed<Record<number, number>>(() =>
    foregroundRecord.value ? milestonesOf(foregroundRecord.value) : {},
  );
  /** How many of the journey's steps are done, on the scale the record's own route shows. */
  const journeyDone = computed(() => {
    const record = foregroundRecord.value;
    return record ? journeyStepsOf(record, journeyScaleOf(record.route)) : 1;
  });
  /** True while a claim is in flight: the host's sheet is up, or the credit is being verified. */
  const claiming = computed(() =>
    foregroundRecord.value ? claimingOf(foregroundRecord.value) : false,
  );
  /** The record's progress; a hand-off the worker refused shows as failed on screen while the
   *  record, still awaiting its deposit, waits for the worker's verdict. */
  const foregroundProgress = computed(() => {
    const record = foregroundRecord.value;
    if (!record) return null;
    const failure = transientError.value;
    const snapshot =
      failure !== null && failure.source === "handoff" && rankOf(record) === 0
        ? advanceFundingProgressSnapshot(record.progress, {
            observation: { kind: "failed" },
            at: failure.at,
          })
        : record.progress;
    return { ref: record.ref, startedAt: record.startedAt, snapshot };
  });

  // The Meld poll's views, read from the record on screen.
  /** The Meld payment's stage: `waiting` while the buyer is on the widget, `receiving` once the
   *  buyer left it, `complete` when settled. */
  const meldStage = computed(() =>
    foregroundRecord.value ? meldStageOf(foregroundRecord.value) : null,
  );
  /** The Meld payment is temporarily stuck (provider retrying its crypto delivery). Transient:
   *  the record's rail says so, never terminal on its own. */
  const meldDelayed = computed(() => foregroundRecord.value?.rail.delayed === true);
  /** The adapter's reason for a failed Meld payment. Null unless `meldStage === 'failed'`. */
  const meldFailureMessage = computed<string | null>(() => {
    const record = foregroundRecord.value;
    return record?.rail.stage === "failed" ? (record.rail.failure?.message ?? null) : null;
  });
  /** The ending's own code (`refunded`, `declined`, `cancelled`, `unobserved`, …) as the rail
   *  reported it. Null unless the rail failed. It decides whether a fresh attempt is safe to
   *  offer: `unobserved` means the rail could not tell whether the buyer was charged. */
  const meldFailureCode = computed<string | null>(() => {
    const record = foregroundRecord.value;
    return record?.rail.stage === "failed" ? (record.rail.failure?.code ?? null) : null;
  });
  /** True when the failure is a refund (money taken then returned), not a plain decline. */
  const meldRefunded = computed(() => meldFailureCode.value === "refunded");
  /** True once the buyer finished in the widget. */
  const meldSubmitted = computed(() => foregroundRecord.value?.meldSubmittedAt !== undefined);
  /** Demo only: true once Skip was pressed for the request on screen, so it is never offered again. */
  const depositSkipped = computed(() => foregroundRecord.value?.depositSkippedAt !== undefined);
  /** True once the buyer submitted or the payment completed and the journey took over from the
   *  widget. */
  const meldHandedOff = computed(() =>
    foregroundRecord.value ? meldHandedOffOf(foregroundRecord.value) : false,
  );

  // The foreground clock: while the request on screen awaits its deposit, one clock observation a
  // second lets the reducer expire it at its deadline. Witness-only ticks cost nothing.
  let foregroundClock: ReturnType<typeof setInterval> | null = null;
  function startForegroundClock(): void {
    if (foregroundClock !== null) return;
    foregroundClock = setInterval(() => {
      const record = foregroundRecord.value;
      if (record !== null) void observe(record.ref, { source: "clock", at: requestsNow() });
    }, 1_000);
  }
  function stopForegroundClock(): void {
    if (foregroundClock === null) return;
    clearInterval(foregroundClock);
    foregroundClock = null;
  }
  // The deposit watch: while the request on screen awaits its deposit, the app follows its burner
  // at each best block, so a direct deposit has an early witness in the app as a provider's
  // payment does, and the worker's finalized sighting confirms it. Hosted only; it ends the
  // moment coins show, and a failed subscription is let go until the next sync re-subscribes.
  let depositWatch: {
    key: RequestKey;
    unsubscribe: (() => void) | null;
    stopped: boolean;
  } | null = null;
  const foregroundAwaiting = (): boolean =>
    foregroundRecord.value?.status.kind === "awaiting-deposit";
  function startDepositWatch(): void {
    if (sandboxed.value) return;
    const record = foregroundRecord.value;
    if (record === null || record.status.kind !== "awaiting-deposit") return;
    const { ref } = record;
    const key = requestRefKey(ref);
    if (depositWatch !== null) {
      if (depositWatch.key === key) return;
      stopDepositWatch();
    }
    // Claimed before the subscription lands, so a second start while it is pending is a no-op.
    const watching = { key, unsubscribe: null as (() => void) | null, stopped: false };
    depositWatch = watching;
    const sourceId = effectiveSourceId(ref);
    const failed = (e: unknown): void => {
      if (watching.stopped) return;
      console.warn(
        `[requests] deposit watch for ${sourceId}#${ref.tradeN} failed: ${messageOf(e)}`,
      );
      stopDepositWatch();
    };
    void import("~~/lib/coinage-live")
      .then(({ watchTradeBurner }) =>
        watchTradeBurner(
          sourceId,
          ref.tradeN,
          (free) => {
            if (watching.stopped) return;
            void observe(ref, chainReading(free, requestsNow()));
            if (free > 0n) stopDepositWatch();
          },
          failed,
        ),
      )
      .then((unsubscribe) => {
        if (watching.stopped) unsubscribe();
        else watching.unsubscribe = unsubscribe;
      }, failed);
  }
  function stopDepositWatch(): void {
    if (depositWatch === null) return;
    const watching = depositWatch;
    depositWatch = null;
    watching.stopped = true;
    watching.unsubscribe?.();
  }
  /** The watch follows the request on screen while it awaits its deposit, hosted, and not
   *  otherwise. */
  function syncDepositWatch(): void {
    if (isHosted() && foregroundAwaiting()) startDepositWatch();
    else stopDepositWatch();
  }
  watch(
    () => (foregroundAwaiting() ? foreground.value : null),
    (awaitingKey) => {
      if (awaitingKey !== null) startForegroundClock();
      else stopForegroundClock();
      syncDepositWatch();
    },
    { immediate: true },
  );

  /** The request on screen is gone: the clock, the deposit watch and the polls stop, no key is
   *  foreground, and what the screen showed beside the record goes with it. */
  function leave(): void {
    stopForegroundClock();
    stopDepositWatch();
    stopMeldPoll();
    stopPaymentPoll();
    setForeground(null);
    transientError.value = null;
    fundingNotice.value = null;
  }

  /** `work` settled within `ms`, or why not: its failure, or the bound. */
  type Bounded<T> = { ok: true; value: T } | { ok: false; reason: string };
  /** One read of the host's word on a payment. */
  type HostPaymentReading = { status: HostPaymentStatus; reason?: string; actualClaimed?: string };
  function bounded<T>(label: string, ms: number, work: () => Promise<T>): Promise<Bounded<T>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<Bounded<T>>((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, reason: `${label} did not answer in time` }),
        ms,
      );
    });
    const outcome = new Promise<T>((resolve) => resolve(work())).then(
      (value): Bounded<T> => ({ ok: true, value }),
      (e: unknown): Bounded<T> => ({ ok: false, reason: `${label} failed: ${messageOf(e)}` }),
    );
    return Promise.race([outcome, expiry]).finally(() => clearTimeout(timer));
  }

  /** The job's own money observation: it saw funds, or it is past waiting for them. */
  const jobHasFunds = (job: WorkerJobView): boolean =>
    job.fundsSeenAt !== null ||
    (job.phase !== "starting" && job.phase !== "await-native" && job.phase !== "failed");

  /** The last look before a cancel. A record past its deposit (anyone saw it: the provider's
   *  report counts) refuses at once, with nothing read. Otherwise the burner and the worker's job
   *  are each read within `CANCEL_CONFIRM_MS`: funds in either refuse the cancel and reach the
   *  record as the read that found them; a read that did not answer leaves the cancel
   *  unconfirmed. */
  async function cancel(
    ref: RequestRef,
    opts: { readBurner: () => Promise<bigint> },
  ): Promise<"ok" | "refused" | "unconfirmed"> {
    const record = get(ref);
    // A withdrawal's last look is its own: the key and the host's payment.
    if (record !== undefined && (!isTopUp(record) || rankOf(record) >= 1)) return "refused";
    const at = requestsNow();
    const [burner, jobs] = await Promise.all([
      bounded("the burner read", CANCEL_CONFIRM_MS, opts.readBurner),
      bounded("the worker job read", CANCEL_CONFIRM_MS, readWorkerJobs),
    ]);
    if (burner.ok && burner.value > 0n) {
      await observe(ref, {
        source: "chain",
        at,
        burnerNative: burner.value.toString(),
        finality: "best",
        via: "pre-cancel",
      });
      return "refused";
    }
    const job = jobs.ok
      ? jobs.value[workerSessionId(effectiveSourceId(ref), ref.tradeN)]
      : undefined;
    if (job) {
      const view = jobView(job);
      if (jobHasFunds(view)) {
        await observe(ref, { source: "worker", at, job: view });
        return "refused";
      }
    }
    for (const read of [burner, jobs]) {
      if (!read.ok) {
        console.warn(`[requests] cancel unconfirmed: ${read.reason}`);
        return "unconfirmed";
      }
    }
    return "ok";
  }

  /** A user retry: only a recoverably failed record whose failure the worker's job, or core's
   *  own failed witness, confirms is moved back into the pipeline. A failure the job confirms
   *  first has the stored hand-off re-sent, hosted: the deposit is in, and the worker re-arms a
   *  failed job on a re-sent hand-off; left alone, its next read would fail the record again. A
   *  hand-off that could not be sent is noted on the entry and the record stays failed. The job
   *  poll runs again once the record moves. */
  async function retry(ref: RequestRef): Promise<boolean> {
    const record = get(ref);
    if (
      record === undefined ||
      !isTopUp(record) ||
      record.status.kind !== "failed" ||
      !record.status.recoverable
    ) {
      return false;
    }
    const sessionId = workerSessionId(effectiveSourceId(ref), ref.tradeN);
    const jobs = await readWorkerJobs();
    const job = jobs[sessionId];
    const confirmedByJob =
      job !== undefined &&
      job.phase === "failed" &&
      (job.failure === "shortfall" || job.failure === "timeout" || job.failure === "claim");
    if (!confirmedByJob && record.witnesses.core?.phase !== "failed") {
      console.warn("[requests] retry ignored: the failure is not confirmed as recoverable");
      return false;
    }
    if (confirmedByJob && isHosted()) {
      const key = requestRefKey(ref);
      try {
        if (record.handoff === undefined) throw new Error("the record has no stored hand-off");
        const { getStorageWorkerManager } = await import("~~/lib/worker-rpc");
        await sendHandoff(getStorageWorkerManager(), sessionId, record.handoff);
        patchEntry(key, ({ handoffError: _cleared, ...sent }) => sent);
      } catch (e) {
        const handoffError = messageOf(e);
        console.warn(`[requests] retry for ${key} could not re-arm the worker: ${handoffError}`);
        patchEntry(key, (current) => ({ ...current, handoffError }));
        return false;
      }
    }
    await observe(ref, { source: "user", at: requestsNow(), event: "retry" });
    syncJobPoll();
    return true;
  }

  /** The buyer finished the provider's widget; the stamp is on the host before this resolves. */
  function markMeldSubmitted(ref: RequestRef): Promise<void> {
    return observe(ref, { source: "user", at: requestsNow(), event: "meld-submitted" });
  }

  /** Demo Skip was pressed; the stamp is on the host before this resolves, so a re-open never
   *  offers Skip again for this request. */
  function markDepositSkipped(ref: RequestRef): Promise<void> {
    return observe(ref, { source: "user", at: requestsNow(), event: "deposit-skipped" });
  }

  // The withdrawal's payment. The surface has the worker prompt the purse under an id it derived;
  // the record is stamped with the attempt and its id on the host before the prompt goes out.

  /** The purse is about to be prompted for attempt `attempt` under `id`. */
  function markPaymentRequested(ref: RequestRef, attempt: number, id: string): Promise<void> {
    return observe(ref, {
      source: "user",
      at: requestsNow(),
      event: "payment-requested",
      attempt,
      id,
    });
  }

  /** One read of the host's word on a withdrawal's payment, applied as the host's observation.
   *  Nothing to read before a prompt; a read that fails changes nothing. */
  async function observePaymentStatus(ref: RequestRef): Promise<"ok" | "skipped" | "failed"> {
    const record = get(ref);
    if (record === undefined || !isWithdrawal(record) || record.payment.id === undefined) {
      return "skipped";
    }
    const { attempt, id } = record.payment;
    const at = requestsNow();
    try {
      const { readPaymentStatus } = await import("~~/lib/withdraw-live");
      const reading = await readPaymentStatus(id);
      await observe(ref, { source: "host", at, payment: { attempt, ...reading } });
      return "ok";
    } catch (e) {
      console.warn(
        `[requests] payment status read for ${requestRefKey(ref)} failed: ${messageOf(e)}`,
      );
      return "failed";
    }
  }

  /** The last look before a withdrawal's cancel. A record past its payment, or whose payment the
   *  host has in hand, refuses at once. Otherwise the key's CASH and, once a prompt went out, the
   *  host's status are each read within `CANCEL_CONFIRM_MS`: money in either refuses the cancel
   *  and reaches the record as the read that found it; a read that did not answer leaves the
   *  cancel unconfirmed. */
  async function cancelWithdrawal(
    ref: RequestRef,
    opts: { readKeyCash: () => Promise<bigint> },
  ): Promise<"ok" | "refused" | "unconfirmed"> {
    const record = get(ref);
    if (record === undefined || !isWithdrawal(record)) return "refused";
    if (rankOf(record) >= 1 || paymentTaken(record)) return "refused";
    const at = requestsNow();
    const { attempt, id } = record.payment;
    const [key, host] = await Promise.all([
      bounded("the key read", CANCEL_CONFIRM_MS, opts.readKeyCash),
      id === undefined
        ? Promise.resolve<Bounded<HostPaymentReading | null>>({ ok: true, value: null })
        : bounded("the payment status read", CANCEL_CONFIRM_MS, async () => {
            const { readPaymentStatus } = await import("~~/lib/withdraw-live");
            return readPaymentStatus(id);
          }),
    ]);
    if (key.ok && key.value > 0n) {
      await observe(ref, {
        source: "chain",
        at,
        keyCash: key.value.toString(),
        finality: "best",
        via: "pre-cancel",
      });
      return "refused";
    }
    if (host.ok && host.value !== null) {
      await observe(ref, { source: "host", at, payment: { attempt, ...host.value } });
      if (paymentTaken({ payment: { ...record.payment, ...host.value } })) return "refused";
    }
    for (const read of [key, host]) {
      if (!read.ok) {
        console.warn(`[requests] cancel unconfirmed: ${read.reason}`);
        return "unconfirmed";
      }
    }
    return "ok";
  }

  /** A user retry of a failed withdrawal. A payment that failed gets a fresh attempt for the
   *  surface to prompt; a conversion that failed has its hand-off re-sent, hosted, so the worker
   *  re-arms the job, and is moved back into the pipeline. */
  async function retryWithdrawal(ref: RequestRef): Promise<boolean> {
    const record = get(ref);
    if (
      record === undefined ||
      !isWithdrawal(record) ||
      record.status.kind !== "failed" ||
      !record.status.recoverable
    ) {
      return false;
    }
    if (record.failure?.step !== "payment" && isHosted()) {
      const key = requestRefKey(ref);
      try {
        const [{ getStorageWorkerManager }, { sendWithdrawHandoff }] = await Promise.all([
          import("~~/lib/worker-rpc"),
          import("~~/lib/withdraw-live"),
        ]);
        const sessionId = workerSessionId(effectiveSourceId(ref), ref.tradeN);
        await sendWithdrawHandoff(getStorageWorkerManager(), sessionId, record.handoff);
        patchEntry(key, ({ handoffError: _cleared, ...sent }) => sent);
      } catch (e) {
        const handoffError = messageOf(e);
        console.warn(`[requests] retry for ${key} could not re-arm the worker: ${handoffError}`);
        patchEntry(key, (current) => ({ ...current, handoffError }));
        return false;
      }
    }
    await observe(ref, { source: "user", at: requestsNow(), event: "retry" });
    syncJobPoll();
    return true;
  }

  // Consecutive "not found" answers per request, on screen or in the background.
  const meldNotFound = new Map<RequestKey, number>();

  /** One read of the provider's status for `ref`, applied as the provider's observation: the
   *  result, `gone` on the `MELD_GONE_AFTER`th consecutive 404 (terminal, with today's message),
   *  `unreachable` on an earlier 404 or any other error, logged against the `failures` the caller
   *  has counted so far. */
  async function observeMeldStatus(
    ref: RequestRef,
    client: MeldClientLike,
    fundingRequestId: string,
    failures = 0,
  ): Promise<"ok" | "gone" | "unreachable"> {
    const at = requestsNow();
    const key = requestRefKey(ref);
    try {
      const result = await getMeldStatus(client, fundingRequestId);
      meldNotFound.delete(key);
      await observe(ref, {
        source: "provider",
        provider: "meld",
        at,
        result,
        delayed: result.delayed === true,
      });
      return "ok";
    } catch (e) {
      const httpStatus = (e as { status?: number } | null)?.status;
      if (httpStatus === 404) {
        const notFound = (meldNotFound.get(key) ?? 0) + 1;
        if (notFound < MELD_GONE_AFTER) {
          meldNotFound.set(key, notFound);
          console.warn(
            `[meld] status for ${fundingRequestId} not found (${String(notFound)}/${String(MELD_GONE_AFTER)})`,
          );
          await observe(ref, { source: "provider", provider: "meld", at, unreachable: true });
          return "unreachable";
        }
        meldNotFound.delete(key);
        console.error(
          `[meld] status poll got a terminal 404 for ${fundingRequestId}, stopping:`,
          e,
        );
        await observe(ref, {
          source: "provider",
          provider: "meld",
          at,
          gone: true,
          message: MELD_GONE_MESSAGE,
        });
        return "gone";
      }
      meldNotFound.delete(key);
      // A 401 is an auth problem on this side and retries with the other transients.
      if (httpStatus === 401) {
        console.error(
          `[meld] status poll unauthorized for ${fundingRequestId}; check VITE_MELD_PRODUCT_ID / adapter auth. Retrying; the payment is NOT being declared failed:`,
          e,
        );
      }
      const failed = failures + 1;
      if (failed >= 5) {
        console.error(
          `[meld] status poll has failed ${String(failed)} times for ${fundingRequestId}:`,
          e,
        );
      } else {
        console.warn("[meld] status poll failed (will retry):", e);
      }
      await observe(ref, { source: "provider", provider: "meld", at, unreachable: true });
      return "unreachable";
    }
  }

  let meldPoll: { key: RequestKey; stop(): void; pause(): void; resume(): void } | null = null;

  /** Polls the provider's status for the Meld request on screen every `MELD_POLL_MS`, one poll
   *  at a time, until its rail is delivered or failed, the payment is gone, or the record is
   *  removed. Starting it again for the same request is a no-op; for another request it replaces
   *  the running poll. */
  function startMeldPoll(ref: RequestRef, client: MeldClientLike, fundingRequestId: string): void {
    if (sandboxed.value) return;
    const key = requestRefKey(ref);
    if (meldPoll?.key === key) return;
    stopMeldPoll();
    let stopped = false;
    let paused = false;
    let inFlight = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clearTimer = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    meldPoll = {
      key,
      stop() {
        stopped = true;
        clearTimer();
      },
      pause() {
        paused = true;
        clearTimer();
      },
      resume() {
        if (!paused) return;
        paused = false;
        void tick();
      },
    };
    // The record may still be on its way to the store when the first tick runs; only a record
    // that was seen and has since gone ends the poll.
    let seen = false;
    const finished = (): boolean => {
      const record = entries.value[key]?.record;
      if (record === undefined) return seen;
      seen = true;
      return record.rail.stage === "delivered" || record.rail.stage === "failed";
    };
    // One read at a time: a resume while a read is in flight leaves the scheduling to it.
    const tick = async (): Promise<void> => {
      if (stopped || paused || inFlight) return;
      inFlight = true;
      const outcome = await observeMeldStatus(ref, client, fundingRequestId, failures);
      inFlight = false;
      failures = outcome === "ok" ? 0 : failures + 1;
      if (stopped || paused) return;
      if (outcome === "gone" || finished()) {
        stopMeldPoll();
        return;
      }
      timer = setTimeout(() => void tick(), MELD_POLL_MS);
    };
    void tick();
  }
  function stopMeldPoll(): void {
    meldPoll?.stop();
    meldPoll = null;
  }

  // The payment poll: while the withdrawal on screen awaits its payment and the host's id is
  // known, the host's status is read every PAYMENT_POLL_MS, one read at a time. The key's CASH is
  // the worker's to see; this poll only brings the host's own word forward.
  let paymentPoll: { key: RequestKey; timer: ReturnType<typeof setTimeout> | null } | null = null;
  const foregroundAwaitingPayment = (): WithdrawalRecord | null => {
    const record = foregroundWithdrawal.value;
    return record !== null &&
      record.status.kind === "awaiting-payment" &&
      record.payment.id !== undefined
      ? record
      : null;
  };
  function startPaymentPoll(): void {
    if (sandboxed.value) return;
    const record = foregroundAwaitingPayment();
    if (record === null) return;
    const key = requestRefKey(record.ref);
    if (paymentPoll?.key === key) return;
    stopPaymentPoll();
    const poll = { key, timer: null as ReturnType<typeof setTimeout> | null };
    paymentPoll = poll;
    const tick = async (): Promise<void> => {
      if (paymentPoll !== poll) return;
      await observePaymentStatus(record.ref);
      if (paymentPoll !== poll) return;
      if (foregroundAwaitingPayment()?.ref !== record.ref) {
        stopPaymentPoll();
        return;
      }
      poll.timer = setTimeout(() => void tick(), PAYMENT_POLL_MS);
    };
    void tick();
  }
  function stopPaymentPoll(): void {
    if (paymentPoll === null) return;
    if (paymentPoll.timer !== null) clearTimeout(paymentPoll.timer);
    paymentPoll = null;
  }
  /** The poll follows the withdrawal on screen while it awaits its payment, and not otherwise. */
  function syncPaymentPoll(): void {
    if (foregroundAwaitingPayment() !== null) startPaymentPoll();
    else stopPaymentPoll();
  }
  watch(
    () => foregroundAwaitingPayment()?.payment.id ?? null,
    () => syncPaymentPoll(),
    { immediate: true },
  );

  /** The provider's word can still move the record: it awaits or has seen its deposit, or it
   *  expired or failed without the provider's final word and a late "received" can still re-open
   *  it, until the deposit window plus the tombstone grace is out. */
  function meldCanMove(record: TopUpRecord): boolean {
    const { status, rail, deadline } = record;
    switch (status.kind) {
      case "awaiting-deposit":
      case "deposit-seen":
        return true;
      case "expired":
      case "failed":
        return (
          rail.stage !== "failed" &&
          requestsNow() <=
            (deadline.depositExpiresAt ?? record.startedAt + depositWindowFor(record.route)) +
              TOMBSTONE_GRACE_MS
        );
      default:
        return false;
    }
  }

  /** Reconcile's provider step, hosted only: one status read for every Meld request off screen
   *  that the provider can still move. Skipped when this build has no adapter. */
  async function readBackgroundMeldStatuses(): Promise<void> {
    if (sandboxed.value) return;
    if (!isHosted()) return;
    const client = meldStatusClientFactory();
    if (client === null) return;
    const pending = topUps.value.flatMap((record) => {
      const { meldFundingRequestId: fundingRequestId, ref } = record;
      return fundingRequestId === undefined ||
        record.rail.provider !== "meld" ||
        !meldCanMove(record) ||
        requestRefKey(ref) === foreground.value
        ? []
        : [{ ref, fundingRequestId }];
    });
    await inParallel(pending, MELD_READ_PARALLELISM, async ({ ref, fundingRequestId }) => {
      await observeMeldStatus(ref, client, fundingRequestId);
    });
  }

  /** A burner's balance as the chain's own sighting of the request. */
  const chainReading = (free: bigint, at: number): Observation => ({
    source: "chain",
    at,
    burnerNative: free.toString(),
    finality: "best",
    via: "probe",
  });
  /** A withdrawal key's CASH as the chain's own sighting of the request. */
  const keyReading = (cash: bigint, at: number): Observation => ({
    source: "chain",
    at,
    keyCash: cash.toString(),
    finality: "best",
    via: "probe",
  });

  /** Reconcile's host step, hosted only: one status read for every withdrawal off screen that
   *  awaits its payment under a known id. The foreground's own poll covers the one on screen. */
  async function readPaymentStatuses(): Promise<void> {
    if (sandboxed.value) return;
    if (!isHosted()) return;
    const pending = withdrawals.value.filter(
      (record) =>
        record.status.kind === "awaiting-payment" &&
        record.payment.id !== undefined &&
        requestRefKey(record.ref) !== foreground.value,
    );
    await inParallel(pending, MELD_READ_PARALLELISM, async (record) => {
      await observePaymentStatus(record.ref);
    });
  }

  /** Reconcile's chain step for withdrawals, hosted only: every key nothing else is watching is
   *  read, each read bounded, a failed read changing nothing. (a) A cancelled or expired
   *  withdrawal: CASH resurrects it; a cancelled one confirmed empty past its window and grace is
   *  removed. (b) An unpaid withdrawal whose worker is unknown, stale or not running. (a) runs on
   *  boot and return only, (b) every time. */
  async function readWithdrawKeys(reason: string, now: number, blobs: WorkerBlobs): Promise<void> {
    if (sandboxed.value) return;
    if (!isHosted()) return;
    if (withdrawals.value.length === 0) return;
    const [{ probeWithdrawKey }, { getStorageWorkerManager }] = await Promise.all([
      import("~~/lib/withdraw-live"),
      import("~~/lib/worker-rpc"),
    ]);
    const onReturn = reason === "boot" || reason === "visible";
    const workerAlive = getStorageWorkerManager().isAvailable();

    async function probe(record: WithdrawalRecord): Promise<bigint | null> {
      const { ref } = record;
      const sourceId = effectiveSourceId(ref);
      const read = await bounded(`key read for ${sourceId}#${ref.tradeN}`, PROBE_BOUND_MS, () =>
        probeWithdrawKey(sourceId, ref.tradeN),
      );
      if (!read.ok) {
        console.warn(`[requests] ${read.reason} (kept)`);
        return null;
      }
      await observe(ref, keyReading(read.value.cash, now));
      return read.value.cash;
    }

    if (onReturn) {
      const tombstoned = withdrawals.value.filter(
        (record) => record.status.kind === "cancelled" || record.status.kind === "expired",
      );
      await inParallel(tombstoned, CHAIN_READ_PARALLELISM, async (record) => {
        const { ref } = record;
        const cash = await probe(record);
        if (cash === null) return;
        if (cash > 0n) {
          console.warn(`[requests] withdrawal #${ref.tradeN} resurrected: ${cash} CASH on its key`);
          if (record.status.kind === "cancelled") {
            const sessionId = workerSessionId(effectiveSourceId(ref), ref.tradeN);
            await observe(ref, jobObservation(record, blobs, sessionId, now));
          }
          return;
        }
        if (record.status.kind !== "cancelled") return;
        if (record.deadline.paymentExpiresAt + TOMBSTONE_GRACE_MS >= now) return;
        try {
          await remove(ref);
          console.warn(`[requests] withdrawal #${ref.tradeN} reaped: window closed, key empty`);
        } catch (e) {
          console.warn(`[requests] withdrawal #${ref.tradeN} reap failed (kept): ${messageOf(e)}`);
        }
      });
    }

    const unwatched = withdrawals.value.filter((record) => {
      if (record.status.kind !== "awaiting-payment") return false;
      const { worker } = record.witnesses;
      return (
        !workerAlive ||
        worker === undefined ||
        !worker.known ||
        worker.lastTickAt === null ||
        now - worker.lastTickAt > WORKER_STALE_MS
      );
    });
    await inParallel(unwatched, CHAIN_READ_PARALLELISM, async (record) => {
      await probe(record);
    });
  }

  /** Reconcile step 4, hosted only: the chain is asked about every burner nothing else is
   *  watching, each read bounded, a failed read changing nothing. (a) A cancelled or expired
   *  request: funds resurrect it; a cancelled one confirmed empty past its window and grace is
   *  removed (today's reap rule). (b) A waiting request whose worker is unknown, stale or not
   *  running. (c) The gap sweep: under every source this app can run, every trade number from one
   *  to the source's counter with neither a record nor a job is read once and noted under
   *  `getsome:probed`, re-read at most once a day while its deposit window is open; funds with a
   *  core flow slot become a record that the hand-off step sends on this pass. (a) and (c) run on
   *  boot and return only, (b) every time. */
  async function readChain(
    reason: string,
    now: number,
    jobs: Record<string, WorkerJob>,
  ): Promise<void> {
    if (sandboxed.value) return;
    if (!isHosted()) return;
    // Every read here is a top-up's burner on Asset Hub; the withdrawals' keys have their own step.
    const topUpRecords = topUps.value;
    const [
      { probeTradeBurner, readHostedTradeCounter, readFlowSlot, lostRequestHandoff },
      { getStorageWorkerManager },
    ] = await Promise.all([import("~~/lib/coinage-live"), import("~~/lib/worker-rpc")]);
    const onReturn = reason === "boot" || reason === "visible";
    const workerAlive = getStorageWorkerManager().isAvailable();

    /** The worker's job for `ref` as this pass read it: the fact the hand-off step acts on for a
     *  record the worker step did not follow. */
    function observeJob(ref: RequestRef): Promise<void> {
      const job = jobs[workerSessionId(effectiveSourceId(ref), ref.tradeN)];
      return observe(ref, { source: "worker", at: now, job: job ? jobView(job) : null });
    }

    /** One bounded burner read, applied as the chain's observation; null when it failed. */
    async function probe(ref: RequestRef): Promise<{ address: string; free: bigint } | null> {
      const sourceId = effectiveSourceId(ref);
      const read = await bounded(`burner read for ${sourceId}#${ref.tradeN}`, PROBE_BOUND_MS, () =>
        probeTradeBurner(sourceId, ref.tradeN),
      );
      if (!read.ok) {
        console.warn(`[requests] ${read.reason} (kept)`);
        return null;
      }
      await observe(ref, chainReading(read.value.free, now));
      return read.value;
    }

    if (onReturn) {
      const tombstoned = topUpRecords.filter(
        (record) => record.status.kind === "cancelled" || record.status.kind === "expired",
      );
      await inParallel(tombstoned, CHAIN_READ_PARALLELISM, async (record) => {
        const { ref } = record;
        const read = await probe(ref);
        if (read === null) return;
        if (read.free > 0n) {
          console.warn(
            `[requests] request #${ref.tradeN} resurrected: ${read.free} planck on ${read.address}`,
          );
          if (record.status.kind === "cancelled") await observeJob(ref);
          return;
        }
        if (record.status.kind !== "cancelled") return;
        const windowEnd =
          (record.deadline.depositExpiresAt ??
            (record.cancelledAt ?? 0) + depositWindowFor(record.route)) + TOMBSTONE_GRACE_MS;
        if (windowEnd >= now) return;
        try {
          await remove(ref);
          console.warn(
            `[requests] request #${ref.tradeN} reaped: window closed, burner confirmed empty`,
          );
        } catch (e) {
          console.warn(`[requests] request #${ref.tradeN} reap failed (kept): ${messageOf(e)}`);
        }
      });
    }

    const unwatched = topUpRecords.filter((record) => {
      if (record.status.kind !== "awaiting-deposit") return false;
      const { worker } = record.witnesses;
      return (
        !workerAlive ||
        worker === undefined ||
        !worker.known ||
        worker.lastTickAt === null ||
        now - worker.lastTickAt > WORKER_STALE_MS
      );
    });
    await inParallel(unwatched, CHAIN_READ_PARALLELISM, async (record) => {
      await probe(record.ref);
    });

    if (!onReturn) return;
    const store = await getRecordStorage();
    const probed = parseProbed(await store.read(PROBED_KEY));
    let probedChanged = false;
    function noteProbed(sourceId: string, n: number, entry: ProbedNumber): void {
      probed[sourceId] = { ...probed[sourceId], [String(n)]: entry };
      probedChanged = true;
    }
    // Every source a request can run under: a total storage loss leaves no record to learn them
    // from, and a lost number can sit below the highest record.
    const sources = new Set<string>([CRYPTO_SOURCE_ID, ...MELD_SOURCE_IDS]);
    for (const { chain, assets } of SOURCE_CHAINS) {
      for (const asset of assets) {
        const sourceId = sourceIdFor(chain, asset);
        if (sourceId !== undefined) sources.add(sourceId);
      }
    }
    for (const { ref } of topUpRecords) sources.add(effectiveSourceId(ref));
    const gaps: { sourceId: string; n: number }[] = [];
    for (const sourceId of sources) {
      const counter = await bounded(`trade counter read for ${sourceId}`, PROBE_BOUND_MS, () =>
        readHostedTradeCounter(sourceId),
      );
      if (!counter.ok) {
        console.warn(`[requests] ${counter.reason}; gap sweep skipped`);
        continue;
      }
      for (let n = 1; n < counter.value; n++) {
        if (has(requestRefOf(sourceId, n))) continue;
        // A legacy record of the crypto rail's own source sits under the bare ref.
        if (sourceId === CRYPTO_SOURCE_ID && has({ tradeN: n })) continue;
        if (jobs[workerSessionId(sourceId, n)]) continue;
        const seen = probed[sourceId]?.[String(n)];
        if (
          seen !== undefined &&
          (now - seen.lastAt < PROBED_RECHECK_MS ||
            now - seen.firstAt >= depositWindowFor(routeOf(sourceId)))
        ) {
          continue;
        }
        gaps.push({ sourceId, n });
      }
    }
    await inParallel(gaps, CHAIN_READ_PARALLELISM, async ({ sourceId, n }) => {
      const read = await bounded(`burner read for ${sourceId}#${n}`, PROBE_BOUND_MS, () =>
        probeTradeBurner(sourceId, n),
      );
      if (!read.ok) {
        console.warn(`[requests] ${read.reason}`);
        return;
      }
      const firstAt = probed[sourceId]?.[String(n)]?.firstAt ?? now;
      if (read.value.free === 0n) {
        noteProbed(sourceId, n, { firstAt, lastAt: now });
        return;
      }
      const flow = await bounded(`flow slot read for ${sourceId}#${n}`, PROBE_BOUND_MS, () =>
        readFlowSlot(sourceId as SourceId, n),
      );
      if (!flow.ok) {
        console.warn(`[requests] ${flow.reason}`);
        return;
      }
      const { address, slot } = flow.value;
      if (!hasHandoffAmount(slot)) {
        // Funds with no record, no job and no slot: only storage loss gets here, and a truthful
        // row needs an amount the app does not have.
        console.warn(
          `[requests] ${read.value.free} planck on ${address} (${sourceId}#${n}) with no record, job or flow slot; nothing created`,
        );
        noteProbed(sourceId, n, { firstAt, lastAt: now, funded: true });
        return;
      }
      const ref = requestRefOf(sourceId, n);
      const handoff = lostRequestHandoff(sourceId, n, address, slot);
      try {
        await create(ref, recordFromFlowSlot(ref, address, slot, handoff, now));
      } catch (e) {
        console.warn(`[requests] record for lost request ${sourceId}#${n} failed: ${messageOf(e)}`);
        return;
      }
      await observeJob(ref);
      await observe(ref, chainReading(read.value.free, now));
    });
    if (probedChanged) {
      try {
        await store.write(PROBED_KEY, serializeProbed(probed));
      } catch (e) {
        console.warn(`[requests] probed numbers write failed: ${messageOf(e)}`);
      }
    }
  }

  /** Reconcile step 6: the worker is handed every open request it lost, off screen only. The
   *  pass waits for the worker's heartbeat once, up to `WORKER_READY_MS`, and skips every send
   *  when it never comes. A job it has no record of gets the request's stored hand-off as it is;
   *  a job it expired after the buyer paid gets it with a fresh deadline, because the worker
   *  keeps the hand-off's own; a legacy record without a hand-off builds one hosted world to
   *  obtain it, stores it and lets the world go. Nothing here observes the record: the worker's
   *  answer arrives with the next job read. A failure is noted on the entry and the next
   *  reconcile tries again. */
  async function handOffLostRequests(now: number): Promise<void> {
    if (sandboxed.value) return;
    if (!isHosted()) return;
    const lost = records.value.flatMap((record) => {
      const reason = lostHandoff(record);
      return reason === null || requestRefKey(record.ref) === foreground.value
        ? []
        : [{ record, reason }];
    });
    if (lost.length === 0) return;
    const [
      { getStorageWorkerManager },
      { createHostedCoinageWorld, ensureChainSubmitGrant },
      { sendWithdrawHandoff },
    ] = await Promise.all([
      import("~~/lib/worker-rpc"),
      import("~~/lib/coinage-live"),
      import("~~/lib/withdraw-live"),
    ]);
    const worker = getStorageWorkerManager();
    // One wait per pass, so a worker that is down costs the pass one bound, not one per record.
    const readyBy = Date.now() + WORKER_READY_MS;
    while (!worker.isAvailable() && Date.now() < readyBy) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!worker.isAvailable()) {
      console.warn(
        `[requests] worker not running; ${lost.length} hand-off(s) wait for the next pass`,
      );
      for (const { record } of lost) {
        patchEntry(requestRefKey(record.ref), (current) => ({
          ...current,
          handoffError: WORKER_NOT_RUNNING,
        }));
      }
      return;
    }
    // The worker submits on the user's behalf; the grant is requested before the first send.
    await ensureChainSubmitGrant();

    async function obtainHandoff(record: TopUpRecord): Promise<WorkerHandoffPayload> {
      const { ref } = record;
      const amount = toCashBase(record.amountHuman);
      if (amount === null) throw new Error(`'${record.amountHuman}' is not a CASH amount`);
      const world = await createHostedCoinageWorld({
        amount,
        tradeN: ref.tradeN,
        sourceId: effectiveSourceId(ref) as SourceId,
      });
      try {
        const handoff = await world.handoffPayload();
        await setHandoff(ref, handoff);
        return handoff;
      } finally {
        world.dispose();
      }
    }
    // Worlds are built one at a time; a failed build never blocks the next.
    let building: Promise<unknown> = Promise.resolve();
    function buildHandoff(record: TopUpRecord): Promise<WorkerHandoffPayload> {
      const run = () => obtainHandoff(record);
      const next = building.then(run, run);
      building = next.catch(() => {});
      return next;
    }

    await Promise.all(
      lost.map(async ({ record, reason }) => {
        const { ref } = record;
        const key = requestRefKey(ref);
        const sessionId = workerSessionId(effectiveSourceId(ref), ref.tradeN);
        try {
          if (isWithdrawal(record)) {
            // The withdrawal's record always carries its hand-off; an expired job gets a fresh
            // payment window, since the worker keeps the hand-off's own.
            const payload =
              reason === "expired"
                ? { ...record.handoff, paymentExpiresAt: now + PAYMENT_WINDOW_MS }
                : record.handoff;
            await sendWithdrawHandoff(worker, sessionId, payload);
          } else {
            const stored = record.handoff ?? (await buildHandoff(record));
            const payload =
              reason === "expired"
                ? { ...stored, depositExpiresAt: now + depositWindowFor(record.route) }
                : stored;
            await sendHandoff(worker, sessionId, payload);
          }
          patchEntry(key, ({ handoffError: _cleared, ...sent }) => sent);
        } catch (e) {
          const handoffError = messageOf(e);
          console.warn(`[requests] hand-off for ${key} failed: ${handoffError}`);
          patchEntry(key, (current) => ({ ...current, handoffError }));
        }
      }),
    );
  }

  // The job poll: one blob read every JOB_POLL_MS while the page is visible and a request is at
  // rank 0–3.
  let jobPollTimer: ReturnType<typeof setInterval> | null = null;
  let jobPollTick: Promise<void> | null = null;
  const anyWorkerDriven = (): boolean => records.value.some(isWorkerDriven);
  const pageVisible = (): boolean =>
    typeof document === "undefined" || document.visibilityState !== "hidden";

  function startJobPoll(): void {
    if (sandboxed.value || jobPollTimer !== null) return;
    jobPollTimer = setInterval(() => void pollJobs(), JOB_POLL_MS);
  }
  function stopJobPoll(): void {
    if (jobPollTimer === null) return;
    clearInterval(jobPollTimer);
    jobPollTimer = null;
  }
  /** While a withdrawal is the worker's to move, each poll round first nudges the worker into a
   *  pass, as the top-up's loop does. Never throws: the poll reads the blobs either way. */
  async function nudgeWithdrawWorker(): Promise<void> {
    if (!records.value.some((record) => isWithdrawal(record) && isWorkerDriven(record))) return;
    try {
      const [{ getStorageWorkerManager }, { nudgeWithdrawTicks }] = await Promise.all([
        import("~~/lib/worker-rpc"),
        import("~~/lib/withdraw-live"),
      ]);
      nudgeWithdrawTicks(getStorageWorkerManager());
    } catch (e: unknown) {
      console.warn(`[requests] worker nudge failed: ${messageOf(e)}`);
    }
  }
  /** One tick. Single-flight: a tick arriving while the previous one runs joins it, one while
   *  hidden is skipped, and one that finds no request at rank 0–3 stops the poll. */
  function pollJobs(): Promise<void> {
    if (jobPollTick !== null) return jobPollTick;
    if (!anyWorkerDriven()) {
      stopJobPoll();
      return Promise.resolve();
    }
    if (!pageVisible()) return Promise.resolve();
    jobPollTick = nudgeWithdrawWorker()
      .then(() => observeWorkerJobs(requestsNow()))
      .then(() => undefined)
      .catch((e: unknown) => {
        console.warn(`[requests] job poll failed: ${messageOf(e)}`);
      })
      .finally(() => {
        jobPollTick = null;
        if (!anyWorkerDriven()) stopJobPoll();
      });
    return jobPollTick;
  }
  /** The poll runs while a request is at rank 0–3, and not otherwise. */
  function syncJobPoll(): void {
    if (anyWorkerDriven()) startJobPoll();
    else stopJobPoll();
  }

  // The second hand behind `freshness`: it runs while the page is visible and an unfinished
  // record exists.
  const anyUnfinished = (): boolean => records.value.some((record) => !isFinished(record));
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  function syncTick(): void {
    if (pageVisible() && anyUnfinished()) {
      if (tickTimer !== null) return;
      tick.value = requestsNow();
      tickTimer = setInterval(() => {
        tick.value = requestsNow();
      }, 1_000);
    } else if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }
  // The last open record can finish between the sync points, as when the poll settles it.
  watch(anyUnfinished, () => syncTick());
  // A record the worker moves can appear between the sync points too, as when a withdrawal is
  // created: the poll starts with it, and stops itself once nothing is left to follow.
  watch(anyWorkerDriven, () => syncJobPoll());

  /** Hidden: the job poll, the deposit watch, the provider and payment polls and the second hand
   *  stop. The foreground clock keeps running so the deposit still expires on time. */
  function pausePolls(): void {
    stopJobPoll();
    stopDepositWatch();
    meldPoll?.pause();
    stopPaymentPoll();
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }
  /** Visible again: whatever paused starts where it left off, the polls with a read now. */
  function resumePolls(): void {
    syncJobPoll();
    syncDepositWatch();
    syncTick();
    meldPoll?.resume();
    syncPaymentPoll();
  }

  /** Back from a background stint long enough that nothing read before it can be trusted: every
   *  row is cached until this pass confirms it. The chain clients are dropped too; the first
   *  world built after a long stint failed on stale ones, and the clients re-dial on use. The
   *  polls resume only once the clients are gone, so the deposit watch subscribes on a fresh
   *  one rather than one about to be destroyed. */
  async function returnFromBackground(): Promise<void> {
    sessionEpoch.value = requestsNow();
    stopDepositWatch();
    void reconcile("visible");
    if (isHosted()) {
      const { evictChains } = await import("~~/lib/host-chain");
      evictChains();
    }
    resumePolls();
  }

  /** Follows the webview's lifecycle: pending writes land when the page hides, the polls pause,
   *  and a return after `HIDDEN_RESET_MS` reconciles. Returns the function that detaches. */
  function attachLifecycle(targets: { document: DocumentLike; window: WindowLike }): () => void {
    let hiddenAt: number | null = null;
    const onVisibilityChange = (): void => {
      if (targets.document.visibilityState === "hidden") {
        hiddenAt = requestsNow();
        void flush();
        pausePolls();
        return;
      }
      const away = hiddenAt === null ? 0 : requestsNow() - hiddenAt;
      hiddenAt = null;
      if (away > HIDDEN_RESET_MS) void returnFromBackground();
      else resumePolls();
    };
    const onPageHide = (): void => {
      void flush();
    };
    // A bfcache restore is a background stint of unknown length.
    const onPageShow = (event: { persisted?: boolean }): void => {
      if (event.persisted === true) void returnFromBackground();
    };
    targets.document.addEventListener("visibilitychange", onVisibilityChange);
    targets.window.addEventListener("pagehide", onPageHide);
    targets.window.addEventListener("pageshow", onPageShow);
    return () => {
      targets.document.removeEventListener("visibilitychange", onVisibilityChange);
      targets.window.removeEventListener("pagehide", onPageHide);
      targets.window.removeEventListener("pageshow", onPageShow);
    };
  }

  let reconciling: Promise<void> | null = null;
  let reconcileAgain = false;
  /** Brings memory up to date with the host store, then with the worker's jobs, then lets the
   *  clock expire what it must. Single-flight: a caller arriving mid-run makes it run once more,
   *  as a refresh, to catch what landed mid-pass without repeating the boot-only reads. */
  function reconcile(reason: string): Promise<void> {
    if (sandboxed.value) return Promise.resolve();
    if (reconciling) {
      reconcileAgain = true;
      return reconciling;
    }
    reconcilingNow.value = true;
    reconciling = (async () => {
      try {
        await reconcileOnce(reason);
        while (reconcileAgain) {
          reconcileAgain = false;
          await reconcileOnce("refresh");
        }
      } finally {
        reconciling = null;
        reconcilingNow.value = false;
        // A pass that failed before the host step still lets the list paint.
        hostReadDone.value = true;
      }
    })();
    return reconciling;
  }

  async function reconcileOnce(reason: string): Promise<void> {
    let store: KeyedStorage;
    try {
      store = await getRecordStorage();
    } catch (e) {
      storage.value = "unavailable";
      console.warn(`[requests] reconcile (${reason}): record storage unavailable: ${messageOf(e)}`);
      return;
    }
    storage.value = "ok";
    let indexed: RequestRef[] | null;
    try {
      indexed = parseRequestIndex(await store.read(REQUEST_INDEX_KEY));
    } catch (e) {
      // The memory refs are still read; the index itself is left as it is.
      indexed = null;
      console.warn(`[requests] reconcile (${reason}): index read failed: ${messageOf(e)}`);
    }
    const now = requestsNow();
    let changed = false;

    function noteReadError(key: RequestKey, e: unknown): void {
      const readError = messageOf(e);
      console.warn(`[requests] record read failed for ${key} (kept): ${readError}`);
      patchEntry(key, (current) => ({ ...current, readError }));
    }

    async function readOne(ref: RequestRef): Promise<void> {
      const key = requestRefKey(ref);
      const entry = entries.value[key];
      // Finished is terminal: history costs no read once it is in memory.
      if (entry !== undefined && isFinished(entry.record)) {
        if (entry.pendingWrite) scheduleWrite(key);
        return;
      }
      let raw: string | null;
      try {
        raw = await store.read(requestKey(ref));
      } catch (e) {
        noteReadError(key, e);
        return;
      }
      if (raw === null) {
        // The host lost the record, or never got it: memory's copy is written back.
        if (entries.value[key] !== undefined) {
          patchEntry(key, (current) => ({ ...current, pendingWrite: true }));
          scheduleWrite(key);
        }
        return;
      }
      let stored: unknown;
      try {
        stored = JSON.parse(raw);
      } catch (e) {
        noteReadError(key, e);
        return;
      }
      const host = migrateRecord(stored, ref, now);
      if (host === null) return; // unusable, and never pruned
      await enqueue(key, async () => {
        const current = entries.value[key];
        if (current === undefined || host.rev > current.record.rev) {
          setEntry(key, { record: host, pendingWrite: false });
          changed = true;
          return;
        }
        const { readError: _cleared, ...read } = current;
        if (host.rev < current.record.rev) {
          // A write that failed last session: memory is ahead of the host.
          setEntry(key, { ...read, pendingWrite: true });
          scheduleWrite(key);
        } else if (current.readError !== undefined) {
          setEntry(key, read);
        }
      });
    }

    const refs = new Map<RequestKey, RequestRef>();
    for (const ref of indexed ?? []) refs.set(requestRefKey(ref), ref);
    for (const record of records.value) {
      const key = requestRefKey(record.ref);
      if (!refs.has(key)) refs.set(key, record.ref);
    }
    await inParallel([...refs.values()], READ_PARALLELISM, readOne);
    if (changed) writeMirror();
    hostReadDone.value = true;

    if (indexed !== null) {
      const listed = new Set(indexed.map(requestRefKey));
      const missing = records.value
        .map((record) => record.ref)
        .filter((ref) => !listed.has(requestRefKey(ref)));
      if (missing.length > 0) {
        await mutateIndex((current) => [...current, ...missing]).catch((e: unknown) => {
          console.warn(`[requests] reconcile (${reason}): index append failed: ${messageOf(e)}`);
        });
      }
    }

    let blobs: WorkerBlobs = { jobs: {}, withdrawJobs: {} };
    try {
      blobs = await observeWorkerJobs(now);
    } catch (e) {
      console.warn(`[requests] reconcile (${reason}): worker jobs step failed: ${messageOf(e)}`);
    }

    // The clock before the reads and the drivers: a record it expires here gets its chain read in
    // this pass and is not handed off.
    await Promise.all(
      records.value
        .filter((record) => rankOf(record) === 0)
        .map((record) => observe(record.ref, { source: "clock", at: now })),
    );

    try {
      await readChain(reason, now, blobs.jobs);
    } catch (e) {
      console.warn(`[requests] reconcile (${reason}): chain step failed: ${messageOf(e)}`);
    }

    try {
      await readWithdrawKeys(reason, now, blobs);
    } catch (e) {
      console.warn(`[requests] reconcile (${reason}): key step failed: ${messageOf(e)}`);
    }

    try {
      await readBackgroundMeldStatuses();
    } catch (e) {
      console.warn(`[requests] reconcile (${reason}): provider step failed: ${messageOf(e)}`);
    }

    try {
      await readPaymentStatuses();
    } catch (e) {
      console.warn(`[requests] reconcile (${reason}): host step failed: ${messageOf(e)}`);
    }

    try {
      await handOffLostRequests(now);
    } catch (e) {
      console.warn(`[requests] reconcile (${reason}): hand-off step failed: ${messageOf(e)}`);
    }
    syncJobPoll();
    syncTick();
  }

  /** Demo builds only, once per session: every poll and watch stops, memory is emptied, the
   *  records live in a throwaway store with no mirror or adapter, and nothing reads the chain,
   *  the worker or the provider or hands the worker a request again until a reload. */
  function enterSandbox(): void {
    if (sandboxEntered) return;
    sandboxEntered = true;
    sandboxed.value = true;
    stopJobPoll();
    stopMeldPoll();
    stopPaymentPoll();
    stopDepositWatch();
    entries.value = {};
    setRecordStorage(createMemoryKeyedStorage());
    setMirrorStorage(null);
    setMeldStatusClientFactory(() => null);
  }

  /**
   * Empties the sandbox, so a preview scene starts from no records rather than inheriting the
   * ones the scene before it seeded.
   *
   * A no-op until something has entered the sandbox: nothing else may drop records wholesale.
   * Gated on the same module-level latch as the storage it swaps, not on this store's own flag —
   * a second store over an already-sandboxed module holds the deck's records too.
   */
  function clearSandbox(): void {
    if (!sandboxEntered) return;
    entries.value = {};
    setRecordStorage(createMemoryKeyedStorage());
  }

  return {
    entries,
    records,
    openRecords,
    topUps,
    openTopUps,
    withdrawals,
    openWithdrawals,
    sandboxed,
    enterSandbox,
    clearSandbox,
    hydrated,
    hostReadDone,
    storage,
    sessionEpoch,
    reconcilingNow,
    tick,
    freshness,
    get,
    has,
    hasTrace,
    create,
    observe,
    flag,
    setHandoff,
    remove,
    foreground,
    foregroundEntry,
    foregroundRecord,
    foregroundWithdrawal,
    setForeground,
    transientError,
    setTransientError,
    fundingNotice,
    phase,
    fundsSeen,
    fundingStep,
    fundingError,
    claimStage,
    claimedBase,
    milestones,
    journeyDone,
    claiming,
    foregroundProgress,
    meldStage,
    meldDelayed,
    meldFailureMessage,
    meldFailureCode,
    meldRefunded,
    meldSubmitted,
    depositSkipped,
    meldHandedOff,
    leave,
    cancel,
    retry,
    markMeldSubmitted,
    markDepositSkipped,
    cancelWithdrawal,
    retryWithdrawal,
    markPaymentRequested,
    observePaymentStatus,
    startMeldPoll,
    stopMeldPoll,
    startPaymentPoll,
    stopPaymentPoll,
    startForegroundClock,
    stopForegroundClock,
    startDepositWatch,
    stopDepositWatch,
    hydrateFromMirror,
    writeMirror,
    reconcile,
    startJobPoll,
    stopJobPoll,
    pausePolls,
    resumePolls,
    attachLifecycle,
    flush,
  };
});
