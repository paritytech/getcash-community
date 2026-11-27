// The facts the top-up timeline reads off a record. Each is kept from the read that first gave it,
// and a later read never erases one or moves it back, except what a fork took: the deposit's
// block and the conversion. The deposit's block is not taken while the app holds its sighting back.

import type { SwapProgress } from "@getsome/core";
import type {
  ConvertedTx,
  DepositInBlock,
  ObservedFact,
  TopUpRecord,
  WorkerJobView,
} from "./model";

/** The latest of the times, or the largest of the counts, that are known; absent when none is. */
export function latestOf(...values: (number | null | undefined)[]): number | undefined {
  const known = values.filter((value): value is number => value != null);
  return known.length === 0 ? undefined : Math.max(...known);
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

const sameTx = (kept: ConvertedTx, read: ConvertedTx | undefined): boolean =>
  read !== undefined && read.txHash === kept.txHash && read.block === kept.block;

/** Folds one read of the worker's job into the facts kept so far. */
export function workerObserved(record: TopUpRecord, job: WorkerJobView, at: number): TopUpRecord {
  const { depositSeen, conversion, claim } = job;
  // The worker keeps the block it first read any money in, and drops it only for a deposit it
  // counted: one the app took back stays gone until money is read on the account again.
  const followed = depositSeen !== undefined && record.depositDroppedAt === undefined;
  let next = followed ? depositFollowed(record, depositSeen) : record;
  if (conversion !== undefined && next.conversionPreparedAt === undefined) {
    next = { ...next, conversionPreparedAt: conversion.preparedAt };
  }
  // The worker took the conversion back, or sent it again: a fork discarded its block, and the
  // arrival went with it.
  const converted = conversion?.converted;
  if (
    conversion !== undefined &&
    next.converted !== undefined &&
    !sameTx(next.converted, converted)
  ) {
    const { converted: _taken, ...rest } = next;
    const { "cash-on-people": _arrived, ...observedAt } = rest.observedAt ?? {};
    next = { ...rest, observedAt };
  }
  if (converted !== undefined && next.converted === undefined) next = { ...next, converted };
  if (claim?.registeredAt !== undefined && next.claimRegisteredAt === undefined) {
    next = { ...next, claimRegisteredAt: claim.registeredAt };
  }
  if (job.done) next = observedFirst(next, "cash-on-people", at);
  if (claim?.status === "claiming") next = observedFirst(next, "host-claiming", at);
  return next;
}
