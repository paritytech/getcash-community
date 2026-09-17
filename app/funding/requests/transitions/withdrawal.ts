// The withdrawal transition table: how one observation moves a withdrawal record. Pure, and
// returns the same object when nothing changes.
//
// Forward moves are money and the worker: CASH seen on the key, by anyone, completes the payment
// leg; the worker's steps carry the conversion; the worker's done hands over to the rail, or
// completes the request when the destination is Asset Hub itself. Side exits are the host's
// refusal of the payment, the clock on an unpaid request, the worker's failures, and the user's
// cancel while nothing was paid. Money resurrects any side exit left from the payment leg.

import {
  PAYMENT_EXPIRED_REASON,
  SENDING_STEP_ORDER,
  isSendingStep,
  paymentTaken,
  withdrawalRankOf,
  type HostPayment,
  type Observation,
  type PaidVia,
  type SendingStep,
  type WithdrawJobView,
  type WithdrawalFailure,
  type WithdrawalRecord,
  type WithdrawalStatus,
} from "../model";

type Witnesses = WithdrawalRecord["witnesses"];
type ChainObservation = Extract<Observation, { source: "chain"; keyCash: string }>;
type HostObservation = Extract<Observation, { source: "host" }>;
type UserObservation = Extract<Observation, { source: "user" }>;

const EXPIRED_FAILURE: WithdrawalFailure = {
  kind: "expired",
  step: "payment",
  message: PAYMENT_EXPIRED_REASON,
  recoverable: false,
};

export function applyWithdrawal(
  record: WithdrawalRecord,
  observation: Observation,
): WithdrawalRecord {
  const next = apply(record, observation);
  if (next === record) return record;
  const kept = record.status.kind === "sent" ? sentOnly(record, next) : next;
  return { ...kept, updatedAt: observation.at };
}

function apply(record: WithdrawalRecord, observation: Observation): WithdrawalRecord {
  switch (observation.source) {
    case "worker":
      return "withdrawJob" in observation
        ? applyWorker(record, observation.at, observation.withdrawJob)
        : record;
    case "chain":
      return "keyCash" in observation ? applyChain(record, observation) : record;
    case "host":
      return applyHost(record, observation);
    case "clock":
      return applyClock(record, observation.at);
    case "user":
      return applyUser(record, observation);
    case "core":
    case "provider":
      return record;
  }
}

/** Sent is terminal: of what an observation changed, only the witnesses, the rail and
 *  `confirmedAt` are kept. */
function sentOnly(record: WithdrawalRecord, next: WithdrawalRecord): WithdrawalRecord {
  return {
    ...record,
    witnesses: next.witnesses,
    rail: next.rail,
    ...(next.confirmedAt === undefined ? {} : { confirmedAt: next.confirmedAt }),
  };
}

function witnessed(record: WithdrawalRecord, patch: Partial<Witnesses>): WithdrawalRecord {
  return { ...record, witnesses: { ...record.witnesses, ...patch } };
}

const atSideExit = (record: WithdrawalRecord): boolean =>
  record.status.kind === "failed" ||
  record.status.kind === "expired" ||
  record.status.kind === "cancelled";

/** CASH on the key: completes the payment leg of a record still at rank 0, side exits included,
 *  and touches nothing past it. */
function paidSeen(
  record: WithdrawalRecord,
  at: number,
  via: PaidVia,
  amount?: string,
): WithdrawalRecord {
  const withAmount =
    amount !== undefined && record.paidAmount === undefined
      ? { ...record, paidAmount: amount }
      : record;
  if (withdrawalRankOf(withAmount) !== 0 || withAmount.status.kind === "paid") return withAmount;
  const { failure: _cleared, ...rest } = withAmount;
  return { ...rest, status: { kind: "paid", at, via } };
}

function failed(
  record: WithdrawalRecord,
  at: number,
  failure: WithdrawalFailure,
): WithdrawalRecord {
  const status: WithdrawalStatus = { kind: "failed", at, recoverable: failure.recoverable };
  return { ...record, status, failure };
}

function converting(record: WithdrawalRecord, at: number, step: SendingStep): WithdrawalRecord {
  return { ...record, status: { kind: "converting", at, step } };
}

/** The PAS is on Asset Hub: the rail's leg begins, or the request is complete when the
 *  destination is Asset Hub itself. */
function arrived(record: WithdrawalRecord, at: number): WithdrawalRecord {
  if (record.rail.provider === "direct") {
    return {
      ...record,
      status: { kind: "sent", at },
      rail: { ...record.rail, stage: "delivered", updatedAt: at },
    };
  }
  return {
    ...record,
    status: { kind: "sending", at },
    rail: { ...record.rail, stage: "delivering", updatedAt: at },
  };
}

function workerWitness(job: WithdrawJobView, at: number): Witnesses["worker"] {
  return {
    known: true,
    phase: job.phase,
    done: job.done,
    fundsSeenAt: job.fundsSeenAt,
    lastTickAt: job.lastTickAt,
    at,
    ...(job.failure === undefined ? {} : { failure: job.failure }),
    ...(job.lastError === undefined ? {} : { lastError: job.lastError }),
    ...(job.txs === undefined ? {} : { txs: job.txs }),
  };
}

function applyWorker(
  record: WithdrawalRecord,
  at: number,
  job: WithdrawJobView | null,
): WithdrawalRecord {
  if (job === null) return witnessed(record, { worker: { known: false, at } });
  const witnessAt = Math.max(at, job.lastTickAt ?? 0);
  let next: WithdrawalRecord = {
    ...witnessed(record, { worker: workerWitness(job, witnessAt) }),
    confirmedAt: at,
  };
  if (job.fundsSeenAt !== null) next = paidSeen(next, job.fundsSeenAt, "worker");
  const rank = withdrawalRankOf(next);
  if (job.phase === "failed") {
    if (atSideExit(next)) return next;
    switch (job.failure) {
      case "rejected":
      case "timeout":
        if (rank < 1) return next;
        return failed(next, at, {
          kind: job.failure,
          step: rank >= 3 ? "send" : "convert",
          message: job.lastError ?? "the conversion failed in the background",
          recoverable: true,
        });
      case "expired":
        return rank === 0 && !paymentTaken(next) ? expired(next, at) : next;
      default:
        return next;
    }
  }
  if (job.done) return rank < 3 ? arrived(next, at) : next;
  if (job.fundsSeenAt !== null && isSendingStep(job.phase)) {
    const { status } = next;
    const laterStep =
      status.kind === "converting" &&
      SENDING_STEP_ORDER[job.phase] > SENDING_STEP_ORDER[status.step];
    if (rank < 2 || laterStep) return converting(next, at, job.phase);
  }
  return next;
}

function applyChain(record: WithdrawalRecord, observation: ChainObservation): WithdrawalRecord {
  const { at, keyCash, finality, block, via } = observation;
  const reading = { keyCash, ...(block === undefined ? {} : { block }), at };
  const next: WithdrawalRecord = {
    ...witnessed(record, { chain: { ...record.witnesses.chain, [finality]: reading } }),
    confirmedAt: at,
  };
  if (BigInt(keyCash) === 0n) return next;
  if (next.status.kind === "sent") {
    return witnessed(next, { conflict: { source: "chain", note: "CASH on a sent key", at } });
  }
  return paidSeen(next, at, via === "probe" ? "chain" : via, keyCash);
}

function applyHost(record: WithdrawalRecord, observation: HostObservation): WithdrawalRecord {
  const { at, payment } = observation;
  const next = witnessed(record, { host: { status: payment.status, at } });
  // The host's word on another attempt is only a witness.
  if (payment.attempt !== record.payment.attempt) return next;
  const updated: HostPayment = {
    ...next.payment,
    status: payment.status,
    updatedAt: at,
    ...(payment.reason === undefined ? {} : { reason: payment.reason }),
    ...(payment.actualClaimed === undefined ? {} : { actualClaimed: payment.actualClaimed }),
  };
  const stamped = { ...next, payment: updated };
  switch (payment.status) {
    case "completed":
      return paidSeen(stamped, at, "host");
    case "partiallyClaimed":
      return paidSeen(stamped, at, "host", payment.actualClaimed);
    case "failed":
      // Money on the key outranks the host's refusal: only an unpaid request fails here.
      if (withdrawalRankOf(stamped) !== 0) {
        return witnessed(stamped, {
          conflict: { source: "host", note: "payment failed after CASH was seen", at },
        });
      }
      if (atSideExit(stamped)) return stamped;
      return failed(stamped, at, {
        kind: "payment-failed",
        step: "payment",
        message: payment.reason ?? "the payment did not go through",
        recoverable: true,
      });
    case "processing":
    case "not-found":
      return stamped;
  }
}

function expired(record: WithdrawalRecord, at: number): WithdrawalRecord {
  return { ...record, status: { kind: "expired", at }, failure: EXPIRED_FAILURE };
}

function applyClock(record: WithdrawalRecord, at: number): WithdrawalRecord {
  const next = witnessed(record, { clock: { at } });
  if (
    next.status.kind === "awaiting-payment" &&
    !paymentTaken(next) &&
    at > next.deadline.paymentExpiresAt
  ) {
    return expired(next, at);
  }
  return next;
}

function applyUser(record: WithdrawalRecord, observation: UserObservation): WithdrawalRecord {
  const { at } = observation;
  switch (observation.event) {
    case "payment-requested": {
      const { attempt, id } = observation;
      if (record.status.kind !== "awaiting-payment" || attempt < record.payment.attempt) {
        return record;
      }
      if (attempt === record.payment.attempt && record.payment.requestedAt !== undefined) {
        return record;
      }
      return { ...record, payment: { attempt, requestedAt: at, id } };
    }
    case "cancelled":
      if (
        record.status.kind === "cancelled" ||
        withdrawalRankOf(record) !== 0 ||
        paymentTaken(record)
      ) {
        return record;
      }
      return { ...record, status: { kind: "cancelled", at } };
    case "retry": {
      if (record.status.kind !== "failed" || !record.status.recoverable) return record;
      const { failure: _cleared, ...rest } = record;
      if (record.failure?.step === "payment") {
        // A fresh attempt: the surface prompts again and stamps it.
        return {
          ...rest,
          status: { kind: "awaiting-payment" },
          payment: { attempt: record.payment.attempt + 1 },
        };
      }
      const worker = record.witnesses.worker;
      const step: SendingStep =
        worker?.known && isSendingStep(worker.phase) ? worker.phase : "swap";
      return { ...rest, status: { kind: "converting", at, step } };
    }
    case "meld-submitted":
    case "deposit-skipped":
      return record;
  }
}
