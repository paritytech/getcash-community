// The facts the top-up timeline reads off a record. Each is kept from the read that first gave it,
// and a later read never erases one or moves it back.

import type { PaymentState, SwapProgress } from "@getsome/core";
import type {
  ChainflipFacts,
  DepositInBlock,
  ObservedFact,
  TopUpRecord,
  WorkerJobView,
} from "./model";

/** The later of two times, or the larger of two counts. */
function latest(current: number | undefined, read: number | undefined): number | undefined {
  if (current === undefined) return read;
  return read === undefined ? current : Math.max(current, read);
}

/** Stamps `fact` at `at`, unless the record observed it before. */
function observedFirst(record: TopUpRecord, fact: ObservedFact, at: number): TopUpRecord {
  if (record.observedAt?.[fact] !== undefined) return record;
  return { ...record, observedAt: { ...record.observedAt, [fact]: at } };
}

/** Stamps a provider status the timeline measures from; `waiting` and `failed` are none. */
export function statusObserved(
  record: TopUpRecord,
  status: SwapProgress | "failed",
  at: number,
): TopUpRecord {
  return status === "waiting" || status === "failed" ? record : observedFirst(record, status, at);
}

/** Stamps the deposit's first sighting on the burner itself. */
export const burnerSighted = (record: TopUpRecord, at: number): TopUpRecord =>
  observedFirst(record, "on-burner", at);

/** Stamps the app's first read of the deposit on the burner in a finalized block. */
export const burnerFinal = (record: TopUpRecord, at: number): TopUpRecord =>
  observedFirst(record, "final-on-burner", at);

/** Drops a burner sighting that a final read showed was never there. */
export function burnerSightingRetracted(record: TopUpRecord): TopUpRecord {
  const { observedAt } = record;
  if (observedAt?.["on-burner"] === undefined && observedAt?.["final-on-burner"] === undefined) {
    return record;
  }
  const kept = { ...observedAt };
  delete kept["on-burner"];
  delete kept["final-on-burner"];
  return { ...record, observedAt: kept };
}

/** `current` when `next` holds the same value in each of its fields, else `next`. */
function keptIfSame<T extends object>(current: T | undefined, next: T): T {
  if (current === undefined) return next;
  const fields = Object.keys(next) as (keyof T)[];
  return fields.every((field) => next[field] === current[field]) ? current : next;
}

type Estimates = ChainflipFacts["estimatedDurationsSeconds"];

/** Each stage's estimate from the latest read that gave one. */
function estimatesKept(current: Estimates, read: Estimates): Estimates {
  if (current === undefined || read === undefined) return read ?? current;
  return keptIfSame(current, {
    deposit: read.deposit ?? current.deposit,
    swap: read.swap ?? current.swap,
    egress: read.egress ?? current.egress,
  });
}

type ChainflipRead = Pick<
  Extract<PaymentState, { phase: "swapping" }>,
  "progress" | "egressScheduledAt"
>;

/** Folds one Chainflip status read into the facts kept so far, and Chainflip's clock into the
 *  witnesses. A DCA swap's chunks follow the read with the most executed. A read that changes
 *  nothing returns `record`. */
export function chainflipObserved(
  record: TopUpRecord,
  { progress, egressScheduledAt }: ChainflipRead,
  at: number,
): TopUpRecord {
  if (progress === undefined && egressScheduledAt === undefined) return record;
  const { lastStatechainUpdateAt, ...read } = progress ?? {};
  const current = record.chainflip;
  const depositConfirmations = latest(current?.depositConfirmations, read.depositConfirmations);
  const chunks =
    read.chunks !== undefined &&
    (current?.chunks === undefined || read.chunks.executed >= current.chunks.executed)
      ? keptIfSame(current?.chunks, read.chunks)
      : current?.chunks;
  const chainflip = keptIfSame(current, {
    depositConfirmations,
    requiredConfirmations: read.requiredConfirmations ?? current?.requiredConfirmations,
    boostedAt: current?.boostedAt ?? read.boostedAt,
    swapScheduledAt: latest(current?.swapScheduledAt, read.swapScheduledAt),
    chunks,
    swapRescheduledAt: latest(current?.swapRescheduledAt, read.swapRescheduledAt),
    estimatedDurationsSeconds: estimatesKept(
      current?.estimatedDurationsSeconds,
      read.estimatedDurationsSeconds,
    ),
    egressScheduledAt: latest(current?.egressScheduledAt, egressScheduledAt),
    confirmationsAt:
      depositConfirmations === current?.depositConfirmations ? current?.confirmationsAt : at,
    chunksAt: chunks?.executed === current?.chunks?.executed ? current?.chunksAt : at,
  });
  const next = chainflip === current ? record : { ...record, chainflip };
  const witnessed = record.witnesses.chainflip?.lastStatechainUpdateAt;
  const clock = latest(witnessed, lastStatechainUpdateAt);
  if (clock === undefined || clock === witnessed) return next;
  return {
    ...next,
    witnesses: { ...next.witnesses, chainflip: { lastStatechainUpdateAt: clock } },
  };
}

function depositFollowed(record: TopUpRecord, seen: DepositInBlock): TopUpRecord {
  const current = record.depositInBlock;
  if (current === undefined) return { ...record, depositInBlock: seen };
  if (seen.finalized <= current.finalized && seen.best <= current.best) return record;
  return {
    ...record,
    depositInBlock: {
      ...current,
      finalized: Math.max(current.finalized, seen.finalized),
      best: Math.max(current.best, seen.best),
    },
  };
}

/** Folds one read of the worker's job into the facts kept so far. */
export function workerObserved(record: TopUpRecord, job: WorkerJobView, at: number): TopUpRecord {
  const { depositSeen, conversion, claim } = job;
  let next = depositSeen === undefined ? record : depositFollowed(record, depositSeen);
  if (conversion !== undefined && next.conversionPreparedAt === undefined) {
    next = { ...next, conversionPreparedAt: conversion.preparedAt };
  }
  if (conversion?.converted !== undefined && next.converted === undefined) {
    next = { ...next, converted: conversion.converted };
  }
  if (claim?.registeredAt !== undefined && next.claimRegisteredAt === undefined) {
    next = { ...next, claimRegisteredAt: claim.registeredAt };
  }
  if (job.done) next = observedFirst(next, "cash-on-people", at);
  if (claim?.status === "claiming") next = observedFirst(next, "host-claiming", at);
  return next;
}
