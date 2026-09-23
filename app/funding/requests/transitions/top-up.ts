// The top-up transition table: how one observation moves a request record. Pure, and returns the
// same object when nothing changes. The rules are the design's 3.1 (legal transitions) and 3.2
// (ownership and precedence).

import type { FailureStep, PaymentState } from "@getsome/core";
import {
  advanceFundingProgressSnapshot,
  fundingProgressSignalForSharedStep,
  progressProviderForSource,
  type FundingProgressSignal,
} from "../../progress";
import {
  CONVERTING_STEP_ORDER,
  DEPOSIT_EXPIRED_REASON,
  FUNDING_HELD_REASON,
  PROVISIONAL_REVERT_MS,
  buyerPaid,
  effectiveSourceId,
  isConvertingStep,
  isTerminal,
  rankOf,
  type ConvertingStep,
  type DepositSeenVia,
  type Observation,
  type RailState,
  type RequestFailure,
  type TopUpRecord,
  type RequestStatus,
  type WorkerJobView,
} from "../model";
import { mergeRail, railFromSwapStatus, stageRank } from "../rail";

type Witnesses = TopUpRecord["witnesses"];
type Assurance = Extract<RequestStatus, { kind: "deposit-seen" }>["assurance"];
type ChainObservation = Extract<Observation, { source: "chain"; burnerNative: string }>;
type UserObservation = Extract<Observation, { source: "user" }>;
type ProviderResult = Extract<Observation, { source: "provider"; result: unknown }>;
/** The fields a positive money observation clears from a record it resurrects. */
type ClearedField = "cancelledAt" | "failureReason" | "refunded" | "failure";

const FAILED: FundingProgressSignal = { observation: { kind: "failed" } };
const SETTLED: FundingProgressSignal = { observation: { kind: "settled" } };
const HOLD: FundingProgressSignal = { observation: { kind: "hold" } };
const ROUTE_COMPLETE: FundingProgressSignal = {
  observation: { kind: "route-complete" },
  routeStatus: "complete",
};
const EXPIRED_FAILURE: RequestFailure = {
  kind: "expired",
  step: "deposit",
  message: DEPOSIT_EXPIRED_REASON,
  recoverable: false,
};

export function applyTopUp(record: TopUpRecord, observation: Observation): TopUpRecord {
  const next = apply(record, observation);
  if (next === record) return record;
  const kept = isTerminal(record.status) ? settledOnly(record, next) : next;
  return { ...kept, updatedAt: observation.at };
}

function apply(record: TopUpRecord, observation: Observation): TopUpRecord {
  switch (observation.source) {
    case "core":
      return "state" in observation
        ? applyCoreState(record, observation.at, observation.state)
        : applyCoreClaim(record, observation.claim.claimed);
    case "worker":
      return "job" in observation ? applyWorker(record, observation.at, observation.job) : record;
    case "provider":
      if ("result" in observation) return applyProviderResult(record, observation);
      if ("gone" in observation) {
        return applyProviderGone(record, observation.at, observation.message);
      }
      return applyProviderUnreachable(record, observation.at);
    case "chain":
      return "burnerNative" in observation ? applyChain(record, observation) : record;
    case "clock":
      return applyClock(record, observation.at);
    case "user":
      return applyUser(record, observation);
    case "host":
      return record;
  }
}

/** Settled is terminal: of what an observation changed, only the witnesses, the rail, a missing
 *  `claimed` and `confirmedAt` are kept. */
function settledOnly(record: TopUpRecord, next: TopUpRecord): TopUpRecord {
  return {
    ...record,
    witnesses: next.witnesses,
    rail: next.rail,
    ...(record.claimed === undefined && next.claimed !== undefined
      ? { claimed: next.claimed }
      : {}),
    ...(next.confirmedAt === undefined ? {} : { confirmedAt: next.confirmedAt }),
  };
}

function advanced(record: TopUpRecord, signal: FundingProgressSignal, at: number): TopUpRecord {
  const progress = advanceFundingProgressSnapshot(record.progress, { ...signal, at });
  return progress === record.progress ? record : { ...record, progress };
}

function witnessed(record: TopUpRecord, patch: Partial<Witnesses>): TopUpRecord {
  return { ...record, witnesses: { ...record.witnesses, ...patch } };
}

function without(record: TopUpRecord, fields: readonly ClearedField[]): TopUpRecord {
  const copy = { ...record };
  for (const field of fields) delete copy[field];
  return copy;
}

const earliest = (funded: number | undefined, at: number): number =>
  funded === undefined ? at : Math.min(funded, at);

/** The leg a record leaves when it fails at `rank`; `rankOf` reads it back. Core's own step
 *  speaks about the core flow's legs and cannot stand in for it. */
const stepLeft = (rank: number): FailureStep =>
  rank >= 3 ? "mint" : rank === 2 ? "swap" : "deposit";

/** A side exit is left only by money (resurrection) or by the user; a failure or expiry
 *  observation never turns one side exit into another. */
const atSideExit = (record: TopUpRecord): boolean =>
  record.status.kind === "failed" ||
  record.status.kind === "expired" ||
  record.status.kind === "cancelled";

/** A positive money observation: moves a rank-0 record (or a side exit left from rank 0) to
 *  deposit-seen, and firms up a provisional sighting. Never touches a record past rank 1. Money
 *  on the burner itself (the worker, the faucet, a chain read, the pre-cancel read) completes the
 *  payment leg; the conversion stage waits for the worker's swap report. A sighting on the
 *  provider's side holds, and the branch's own route observation carries the stage. */
function moneySeen(
  record: TopUpRecord,
  at: number,
  assurance: Assurance,
  via: DepositSeenVia,
): TopUpRecord {
  const { status } = record;
  if (status.kind === "deposit-seen") {
    if (status.assurance !== "provisional" || assurance !== "finalized") return record;
    return { ...record, status: { ...status, assurance }, funded: earliest(record.funded, at) };
  }
  if (rankOf(record) !== 0) return record;
  const seen: TopUpRecord = {
    ...without(record, ["cancelledAt", "failureReason", "refunded", "failure"]),
    status: { kind: "deposit-seen", at, assurance, via },
    funded: earliest(record.funded, at),
  };
  const onBurner = via !== "core" && via !== "rail";
  return advanced(seen, onBurner ? ROUTE_COMPLETE : HOLD, at);
}

function failed(record: TopUpRecord, at: number, failure: RequestFailure): TopUpRecord {
  const status: RequestStatus = { kind: "failed", at, recoverable: failure.recoverable };
  return advanced({ ...record, status, failure, failureReason: failure.message }, FAILED, at);
}

function expired(record: TopUpRecord, at: number): TopUpRecord {
  const status: RequestStatus = { kind: "expired", at };
  return advanced(
    { ...record, status, failure: EXPIRED_FAILURE, failureReason: DEPOSIT_EXPIRED_REASON },
    FAILED,
    at,
  );
}

function settled(record: TopUpRecord, at: number): TopUpRecord {
  return advanced({ ...record, status: { kind: "settled", at }, settledAt: at }, SETTLED, at);
}

/** The conversion started no later than the step that follows it: a record whose first worker
 *  report is already past the swap still gets the stage stamped, at that report's instant. */
function conversionStarted(record: TopUpRecord, at: number): TopUpRecord {
  return record.progress.stageTimestamps["cash-conversion"] === undefined
    ? advanced(record, fundingProgressSignalForSharedStep("swap"), at)
    : record;
}

function claiming(record: TopUpRecord, at: number): TopUpRecord {
  const status: RequestStatus = { kind: "claiming", at };
  return advanced(
    conversionStarted({ ...record, status }, at),
    fundingProgressSignalForSharedStep("done"),
    at,
  );
}

function converting(record: TopUpRecord, at: number, step: ConvertingStep): TopUpRecord {
  const status: RequestStatus = { kind: "converting", at, step };
  return advanced(
    conversionStarted({ ...record, status }, at),
    fundingProgressSignalForSharedStep(step),
    at,
  );
}

function sameDeposit(
  current: TopUpRecord["deposit"],
  opened: NonNullable<TopUpRecord["deposit"]>,
): boolean {
  return (
    current !== undefined &&
    current.address === opened.address &&
    current.amount === opened.amount &&
    current.formatted === opened.formatted &&
    current.assetSymbol === opened.assetSymbol &&
    current.expiresAt === opened.expiresAt
  );
}

function applyCoreState(record: TopUpRecord, at: number, state: PaymentState): TopUpRecord {
  const next = witnessed(record, { core: { phase: state.phase, at } });
  switch (state.phase) {
    case "awaiting-deposit": {
      const { deposit } = state;
      const opened: TopUpRecord["deposit"] = {
        address: deposit.address,
        amount: deposit.amount.toString(),
        formatted: deposit.formatted,
        assetSymbol: deposit.assetSymbol,
        expiresAt: deposit.expiresAt,
      };
      const depositExpiresAt = deposit.expiresAt > 0 ? deposit.expiresAt : record.depositExpiresAt;
      // Core repeats this state on every reopen; the same deposit is the witness alone.
      if (
        sameDeposit(record.deposit, opened) &&
        record.depositAddress === deposit.address &&
        record.depositExpiresAt === depositExpiresAt
      ) {
        return next;
      }
      return {
        ...next,
        deposit: opened,
        depositAddress: deposit.address,
        ...(depositExpiresAt === undefined ? {} : { depositExpiresAt }),
      };
    }
    case "swapping": {
      let seen = next;
      // Core's view of the rail counts only while no provider poll has reported.
      if (seen.witnesses.provider === undefined) {
        const rail = mergeRail(
          seen.rail,
          railFromSwapStatus(seen.rail.provider, { status: state.swap }, at),
        );
        seen = { ...seen, rail };
        if (rail.stage !== "failed" && stageRank(rail.stage) >= stageRank("received")) {
          seen = moneySeen(seen, at, "provisional", "core");
        }
      }
      const provider = progressProviderForSource(effectiveSourceId(record.ref));
      return advanced(
        seen,
        { observation: provider.observeRoute(state.swap), routeStatus: state.swap },
        at,
      );
    }
    case "funded":
    case "working":
      return rankOf(next) < 3 ? claiming(next, at) : next;
    case "done":
      return next.status.kind === "settled" ? next : settled(next, at);
    case "failed": {
      const refundLike =
        state.failure.kind === "refunded" || state.failure.kind === "refund-failed";
      const refunded = refundLike ? true : next.refunded;
      const failure: RequestFailure = {
        ...state.failure,
        step: stepLeft(rankOf(record)),
        ...(refunded === undefined ? {} : { refunded }),
        ...(state.refund === undefined ? {} : { refund: state.refund }),
      };
      const detailed: TopUpRecord = {
        ...next,
        failure,
        failureReason: failure.message,
        ...(refunded === undefined ? {} : { refunded }),
      };
      // A non-recoverable failure past deposit-seen only updates the detail: the money leg is
      // the worker's to fail.
      if (atSideExit(record) || (rankOf(record) > 1 && !state.failure.recoverable)) {
        return detailed;
      }
      return failed(detailed, at, failure);
    }
    default:
      return next;
  }
}

function applyCoreClaim(record: TopUpRecord, claimed: string | undefined): TopUpRecord {
  return claimed !== undefined && record.claimed === undefined ? { ...record, claimed } : record;
}

/** The amount a claim credited, or undefined when the worker recorded none. */
function claimedAmount(amount: string | undefined): string | undefined {
  return amount !== undefined && amount !== "" && BigInt(amount) > 0n ? amount : undefined;
}

function workerWitness(job: WorkerJobView, at: number): Witnesses["worker"] {
  return {
    known: true,
    phase: job.phase,
    done: job.done,
    fundsSeenAt: job.fundsSeenAt,
    lastTickAt: job.lastTickAt,
    at,
    ...(job.failure === undefined ? {} : { failure: job.failure }),
    ...(job.claim === null ? {} : { claimPhase: job.claim.phase }),
    ...(job.claim?.status === undefined ? {} : { claimStatus: job.claim.status }),
    ...(job.txs === undefined ? {} : { txs: job.txs }),
  };
}

function applyWorker(record: TopUpRecord, at: number, job: WorkerJobView | null): TopUpRecord {
  if (job === null) return witnessed(record, { worker: { known: false, at } });
  const witnessAt = Math.max(at, job.lastTickAt ?? 0, job.claim?.at ?? 0);
  let next: TopUpRecord = {
    ...witnessed(record, { worker: workerWitness(job, witnessAt) }),
    confirmedAt: at,
  };
  // A job that saw funds is a money observation whatever its phase says (3.2, rule 3).
  if (job.fundsSeenAt !== null) next = moneySeen(next, job.fundsSeenAt, "finalized", "worker");
  const rank = rankOf(next);
  if (job.claim?.phase === "claimed") {
    const claimed = claimedAmount(job.claim.amount ?? job.claim.credited);
    if (next.status.kind === "settled") {
      return claimed !== undefined && next.claimed === undefined ? { ...next, claimed } : next;
    }
    return settled(claimed === undefined ? next : { ...next, claimed }, job.claim.at);
  }
  if (job.phase === "failed") {
    if (atSideExit(next)) return next;
    if (job.failure === "claim" && rank >= 1) {
      // The host would not settle the claim: the conversion is done, so the exit keeps the
      // claim's rank whatever the record had reached.
      return failed(next, at, {
        kind: "mint",
        step: "mint",
        message: job.lastError ?? "the claim failed",
        recoverable: true,
      });
    }
    if ((job.failure === "shortfall" || job.failure === "timeout") && rank >= 1) {
      // The worker has the deposit in hand, so the exit keeps at least the conversion's rank.
      return failed(next, at, {
        kind: "mint",
        step: rank >= 3 ? "mint" : "swap",
        message: job.lastError ?? "funding failed in the background",
        recoverable: true,
      });
    }
    if (job.failure === "held" && rank >= 1) {
      // The PSM refused the mint three times over and the worker stopped with the deposit still
      // on the burner (local/psm/PLAN.md §2.3): recoverable, since a re-sent hand-off re-arms the
      // job with a fresh refusal count. The buyer reads the app's own words, not the chain's.
      return failed(next, at, {
        kind: "mint",
        step: rank >= 3 ? "mint" : "swap",
        message: FUNDING_HELD_REASON,
        recoverable: true,
      });
    }
    if (job.failure === "expired" && rank === 0 && !buyerPaid(next)) {
      return expired(next, at);
    }
    return next;
  }
  if (job.done) return rank < 3 ? claiming(next, at) : next;
  if (job.fundsSeenAt !== null && isConvertingStep(job.phase)) {
    const { status } = next;
    const laterStep =
      status.kind === "converting" &&
      CONVERTING_STEP_ORDER[job.phase] > CONVERTING_STEP_ORDER[status.step];
    if (rank < 2 || laterStep) return converting(next, at, job.phase);
  }
  return next;
}

function applyProviderResult(record: TopUpRecord, observation: ProviderResult): TopUpRecord {
  const { at, result } = observation;
  // The record's own rail keeps its provider; a poll never rewrites it (a manual-rail record
  // stays manual under a Chainflip-shaped failure report).
  const rail = mergeRail(
    record.rail,
    railFromSwapStatus(record.rail.provider, result, at, observation.delayed),
  );
  let next = witnessed(rail === record.rail ? record : { ...record, rail }, {
    provider: { status: result.status, at },
  });
  if (rail.stage !== record.rail.stage || rail.status !== record.rail.status) {
    const provider = progressProviderForSource(effectiveSourceId(record.ref));
    next = advanced(
      next,
      { observation: provider.observeRoute(result.status), routeStatus: result.status },
      at,
    );
  }
  if (rail.stage !== "failed" && stageRank(rail.stage) >= stageRank("received")) {
    // The rail reports the buyer paid; a payment reported after the window closed re-opens the
    // request.
    if (next.status.kind === "expired") next = { ...next, status: { kind: "awaiting-deposit" } };
    return moneySeen(next, at, "provisional", "rail");
  }
  // The provider gives up before any money reached the burner: nothing was seen, or only the
  // provider's own side saw it (Meld's "seen" is the fiat leg moving; a decline or a refund can
  // still follow). Money on the burner is the worker's to fail: the rail alone records the word.
  const seenOnlyByProvider =
    next.status.kind === "deposit-seen" &&
    next.status.assurance === "provisional" &&
    (next.status.via === "rail" || next.status.via === "core") &&
    !workerSawFunds(next);
  if (
    rail.stage === "failed" &&
    rail.failure !== undefined &&
    (rankOf(next) === 0 || seenOnlyByProvider) &&
    !atSideExit(next)
  ) {
    // A refund-like failure marks the record refunded, as core's own failure does.
    const refundLike = rail.failure.kind === "refunded" || rail.failure.kind === "refund-failed";
    const refunded = refundLike ? true : next.refunded;
    return failed(refunded === undefined ? next : { ...next, refunded }, at, {
      kind: rail.failure.kind,
      step: "deposit",
      message: rail.failure.message,
      recoverable: false,
      ...(refunded === undefined ? {} : { refunded }),
    });
  }
  return next;
}

function applyProviderUnreachable(record: TopUpRecord, at: number): TopUpRecord {
  // A poll that cannot confirm the delay must not keep asserting it.
  if (!record.rail.delayed) return record;
  return { ...record, rail: { ...record.rail, delayed: false, updatedAt: at } };
}

function applyProviderGone(record: TopUpRecord, at: number, message: string): TopUpRecord {
  const rail: RailState = {
    ...record.rail,
    status: "failed",
    stage: "failed",
    // The rail could not tell whether the buyer was charged, which is what `unobserved` means
    // everywhere else; the ending is this reducer's own verdict, not one the provider reported.
    failure: { kind: "unknown", message, code: "unobserved" },
    delayed: false,
    updatedAt: at,
  };
  const next = { ...record, rail };
  if (rankOf(next) !== 0 || atSideExit(next)) return next;
  return failed(next, at, { kind: "unknown", step: "deposit", message, recoverable: false });
}

const workerSawFunds = (record: TopUpRecord): boolean => {
  const worker = record.witnesses.worker;
  return worker !== undefined && worker.known && worker.fundsSeenAt !== null;
};

function applyChain(record: TopUpRecord, observation: ChainObservation): TopUpRecord {
  const { at, burnerNative, finality, block, via } = observation;
  const reading = { burnerNative, ...(block === undefined ? {} : { block }), at };
  const next: TopUpRecord = {
    ...witnessed(record, { chain: { ...record.witnesses.chain, [finality]: reading } }),
    confirmedAt: at,
  };
  if (BigInt(burnerNative) > 0n) {
    if (next.status.kind === "settled") {
      return witnessed(next, {
        conflict: { source: "chain", note: "funds on a settled burner", at },
      });
    }
    const assurance: Assurance = finality === "finalized" ? "finalized" : "provisional";
    return moneySeen(next, at, assurance, via === "probe" ? "chain" : via);
  }
  // A zero read is never a money observation; a finalized one can only unwind a chain-provisional
  // sighting that nothing else has confirmed within the revert window.
  const { status } = next;
  if (
    finality === "finalized" &&
    status.kind === "deposit-seen" &&
    status.assurance === "provisional" &&
    status.via === "chain" &&
    at - status.at > PROVISIONAL_REVERT_MS &&
    !workerSawFunds(next)
  ) {
    return { ...next, status: { kind: "awaiting-deposit" } };
  }
  return next;
}

function applyClock(record: TopUpRecord, at: number): TopUpRecord {
  const next = witnessed(record, { clock: { at } });
  const { status, deadline } = next;
  const expirable =
    status.kind === "awaiting-deposit" ||
    (status.kind === "deposit-seen" &&
      status.assurance === "provisional" &&
      status.via === "chain");
  if (
    expirable &&
    !buyerPaid(next) &&
    deadline.depositExpiresAt !== null &&
    at > deadline.depositExpiresAt
  ) {
    return expired(next, at);
  }
  return next;
}

function applyUser(record: TopUpRecord, observation: UserObservation): TopUpRecord {
  const { at } = observation;
  switch (observation.event) {
    case "cancelled": {
      // Rank 0 covers awaiting-deposit, expired and the other side exits left from the deposit.
      if (record.status.kind === "cancelled" || rankOf(record) !== 0) return record;
      const { depositExpiresAt } = observation;
      return {
        ...record,
        status: { kind: "cancelled", at },
        cancelledAt: at,
        ...(depositExpiresAt > 0 ? { depositExpiresAt } : {}),
      };
    }
    case "retry": {
      if (record.status.kind !== "failed" || !record.status.recoverable) return record;
      const worker = record.witnesses.worker;
      const step: ConvertingStep =
        worker?.known && isConvertingStep(worker.phase) ? worker.phase : "swap";
      const status: RequestStatus =
        record.failure?.step === "mint"
          ? { kind: "claiming", at }
          : { kind: "converting", at, step };
      return advanced({ ...without(record, ["failure", "failureReason"]), status }, HOLD, at);
    }
    case "meld-submitted":
      return record.meldSubmittedAt === undefined ? { ...record, meldSubmittedAt: at } : record;
    case "deposit-skipped":
      return record.depositSkippedAt === undefined ? { ...record, depositSkippedAt: at } : record;
    case "payment-requested":
      return record;
  }
}
