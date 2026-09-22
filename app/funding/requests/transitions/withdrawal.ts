// The withdrawal transition table: how one observation moves a withdrawal record. Pure, and
// returns the same object when nothing changes.
//
// Forward moves are money and the worker: CASH seen on the key, by anyone, completes the payment
// leg; the worker's steps carry the conversion; the worker's done hands over to the rail, or
// completes the request when the destination is Asset Hub itself. Side exits are the host's
// refusal of the payment, the clock on an unpaid request, the worker's failures, and the user's
// cancel while nothing was paid. Money resurrects any side exit left from the payment leg.

import type { SwapStatusResult } from "@getsome/core";
import type { MeldDepositDisclosure } from "@getsome/meld";
import {
  PAYMENT_EXPIRED_REASON,
  PAYMENT_WINDOW_MS,
  SENDING_STEP_ORDER,
  isSendingStep,
  meldDepositKnown,
  paymentTaken,
  withdrawalRankOf,
  type HostPayment,
  type MeldSale,
  type Observation,
  type PaidVia,
  type SendingStep,
  type WithdrawJobView,
  type WithdrawalFailure,
  type WithdrawalFailureStep,
  type WithdrawalRailState,
  type WithdrawalRecord,
  type WithdrawalStatus,
} from "../model";

type Witnesses = WithdrawalRecord["witnesses"];
type ChainObservation = Extract<Observation, { source: "chain"; keyCash: string }>;
type HostObservation = Extract<Observation, { source: "host" }>;
type UserObservation = Extract<Observation, { source: "user" }>;
type ProviderObservation = Extract<Observation, { source: "provider" }>;

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
    case "provider":
      return applyProvider(record, observation);
    case "core":
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
      case "unresolved":
        // The worker could not tell whether the provider was paid. This must surface: left as
        // a live "converting" it would sit there forever and nobody would look.
        return failed(next, at, {
          kind: "unresolved",
          step: "send",
          message: job.lastError ?? "the provider payment could not be confirmed",
          recoverable: false,
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

/** The deposit boundary is monotonic: once known, a poll that stops disclosing the address (the
 *  adapter withholds it once the request concludes) does not un-know it — `awaiting-deposit-
 *  address` is left once and never re-entered. */
function saleWithDeposit(sale: MeldSale, deposit: MeldDepositDisclosure | undefined): MeldSale {
  if (deposit === undefined) return sale;
  return sale.phase === "deposit-known"
    ? { ...sale, deposit }
    : { ...sale, phase: "deposit-known", deposit };
}

function saleWithStatus(sale: MeldSale, providerStatus: string | undefined): MeldSale {
  return providerStatus === undefined || providerStatus === sale.providerStatus
    ? sale
    : { ...sale, providerStatus };
}

function meldFailureDetail(result: SwapStatusResult): { message: string; code?: string } {
  const code = typeof result.raw === "string" ? result.raw : undefined;
  return {
    message: result.depositFailure?.reason?.message ?? "the sale could not be completed",
    ...(code === undefined ? {} : { code }),
  };
}

/** The leg a Meld failure leaves, bucketed the way `withdrawalRankOf` reads it back: paid or
 *  earlier reads as the payment leg, mid-conversion as convert. Rank 3 (the chain legs already
 *  carried the committed amount to the provider) is handled separately in `meldFailed`, since no
 *  bucket here can say the money is back. */
const meldFailureStep = (rank: number): WithdrawalFailureStep =>
  rank >= 2 ? "convert" : "payment";

/** Sent, failed, expired or cancelled: nothing a provider poll reports can move the record
 *  further, and treating one as new work here — rather than in the caller — is what let a stale
 *  poll rewrite a finished record's rail underneath `sentOnly`. Self-contained so `meldFailed`
 *  and `applyMeldResult` are each safe to call without relying on `applyProvider` to have
 *  filtered first. */
const meldDone = (record: WithdrawalRecord): boolean =>
  record.status.kind === "sent" || atSideExit(record);

/** A Meld failure the record cannot walk back. Below rank 3 nothing irreversible has happened
 *  yet, so this is an ordinary recoverable-looking side exit like the payment's own failures —
 *  except it is not recoverable: the sale itself ended, and a retry needs a fresh one, which is
 *  outside what this record can do on its own. At rank 3 the committed amount already left the
 *  burner for the provider: whether it landed is undecidable from here, exactly the case
 *  `unresolved` names elsewhere, so the kind matches it rather than inventing a second name for
 *  the same situation — but the provider's own reason travels in `message` regardless, the way
 *  the rank-below-3 branch already carries it, since it is the one piece of evidence support has
 *  for telling "check Asset Hub" apart from "check Meld's dashboard". */
function meldFailed(
  record: WithdrawalRecord,
  at: number,
  detail: { message: string; code?: string },
): WithdrawalRecord {
  if (record.rail.provider !== "meld" || meldDone(record)) return record;
  const rail: WithdrawalRailState = {
    ...record.rail,
    stage: "failed",
    failure: detail,
    updatedAt: at,
  };
  const next = { ...record, rail };
  const rank = withdrawalRankOf(next);
  if (rank >= 3) {
    return failed(next, at, {
      kind: "unresolved",
      step: "send",
      message: detail.message,
      recoverable: false,
    });
  }
  return failed(next, at, {
    kind: "unknown",
    step: meldFailureStep(rank),
    message: detail.message,
    recoverable: false,
  });
}

/** The Meld sale's own lifecycle, folded onto the rail: the deposit address arriving (and never
 *  un-arriving), the provider's own status word carried for display, and the sale's two possible
 *  endings. A settled payout is what finally makes a Meld withdrawal `sent` — checked on the
 *  live `"sending"` status, never on the rank number alone: rank 3 is also where a `send`-step
 *  side exit sits, and a late `complete` must not resurrect one of those into `sent`. */
function applyMeldResult(
  record: WithdrawalRecord,
  at: number,
  result: SwapStatusResult,
  deposit: MeldDepositDisclosure | undefined,
): WithdrawalRecord {
  if (record.rail.provider !== "meld" || meldDone(record)) return record;
  const { rail } = record;
  const raw = typeof result.raw === "string" ? result.raw : undefined;
  const sale = saleWithStatus(saleWithDeposit(rail.sale, deposit), raw);
  const next: WithdrawalRecord =
    sale === rail.sale ? record : { ...record, rail: { ...rail, sale, updatedAt: at } };
  if (result.status === "failed") return meldFailed(next, at, meldFailureDetail(result));
  if (result.status === "complete" && next.status.kind === "sending") {
    return {
      ...next,
      status: { kind: "sent", at },
      rail: { ...next.rail, stage: "delivered", updatedAt: at },
    };
  }
  return next;
}

/** Only the Meld rail is wired: a `direct` withdrawal has no rail leg to hear from, and a
 *  `chainflip` one is not this step's to build. `unreachable` learns nothing new and is a no-op;
 *  `gone` is the adapter losing the request entirely, which this record can only read as a
 *  failure of the sale itself. The witness is stamped here, once, ahead of both branches: it is
 *  what lets the reducer drop a poll older than the last one, the same protection the top-up's
 *  own provider polls already have and withdrawals were missing. A record already done with the
 *  Meld rail (`meldDone`) is left untouched rather than witnessed, so a repeat poll after that
 *  point is a true no-op, not merely one whose status doesn't move. */
function applyProvider(
  record: WithdrawalRecord,
  observation: ProviderObservation,
): WithdrawalRecord {
  if (record.rail.provider !== "meld" || observation.provider !== "meld") return record;
  if (meldDone(record)) return record;
  const next = witnessed(record, { provider: { at: observation.at } });
  if ("unreachable" in observation) return next;
  if ("gone" in observation) {
    return meldFailed(next, observation.at, {
      message: observation.message,
      code: observation.code ?? "unobserved",
    });
  }
  return applyMeldResult(next, observation.at, observation.result, observation.deposit);
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
        paymentTaken(record) ||
        // The Meld sale's own boundary: once the provider has disclosed a deposit address, the
        // sale can be mid-flight on their side even if the rank alone still reads as unpaid.
        meldDepositKnown(record.rail)
      ) {
        return record;
      }
      return { ...record, status: { kind: "cancelled", at } };
    case "retry": {
      if (record.status.kind !== "failed" || !record.status.recoverable) return record;
      const { failure: _cleared, ...rest } = record;
      if (record.failure?.step === "payment") {
        // A fresh attempt: the surface prompts again and stamps it. The payment window restarts
        // with it, on the record's clock and on the hand-off the worker is re-armed with, so a
        // late retry is not expired on arrival.
        const paymentExpiresAt = at + PAYMENT_WINDOW_MS;
        return {
          ...rest,
          status: { kind: "awaiting-payment" },
          payment: { attempt: record.payment.attempt + 1 },
          deadline: { paymentExpiresAt },
          handoff: { ...record.handoff, paymentExpiresAt },
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
