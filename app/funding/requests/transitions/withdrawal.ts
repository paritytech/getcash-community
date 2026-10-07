// The withdrawal transition table: how one observation moves a withdrawal record. Pure, and
// returns the same object when nothing changes.
//
// Forward moves are money and the worker: CASH seen on the key, by anyone, completes the payment
// leg; the worker's steps carry the conversion; the worker's landing hands over to the rail, or
// completes the request when the destination is Asset Hub itself; the provider's word, read by
// the worker, carries the rail leg to sent. Side exits are the host's refusal of the payment, the
// clock on an unpaid request, the worker's failures, the provider's failures, and the user's
// cancel while nothing was paid. Money resurrects any side exit left from the payment leg.
//
// A fiat sale has one step before all of that: the page reads the provider's order until the
// purse is asked. The deposit address it names, checked against the amount and asset the sale
// agreed, becomes the hand-off's channel; an order that ends first ends the record, and the
// payment window starts when the purse is asked, not when the address is named.

import type { FailureKind, TokenSpec } from "@getsome/core";
import { depositTokenOf, recordedRoute } from "@getsome/funding";
import { parseBaseUnits } from "@getsome/meld";
import {
  PAYMENT_EXPIRED_REASON,
  PAYMENT_WINDOW_MS,
  SALE_PAY_WINDOW_MS,
  SENDING_STEP_ORDER,
  isSendingStep,
  paymentTaken,
  saleBeforePurse,
  withdrawalRankOf,
  type HostPayment,
  type MeldSaleReading,
  type Observation,
  type PaidVia,
  type SendingStep,
  type WithdrawJobView,
  type WithdrawalChannel,
  type WithdrawalFailure,
  type WithdrawalFailureKind,
  type WithdrawalRecord,
  type WithdrawalStatus,
} from "../model";
import { mergeRail, railFromSwapStatus } from "../rail";

type Witnesses = WithdrawalRecord["witnesses"];
type ChainObservation = Extract<Observation, { source: "chain"; keyCash: string }>;
type HostObservation = Extract<Observation, { source: "host" }>;
type UserObservation = Extract<Observation, { source: "user" }>;
type SaleObservation = Extract<Observation, { source: "provider"; sale: MeldSaleReading }>;

const EXPIRED_FAILURE: WithdrawalFailure = {
  kind: "expired",
  step: "payment",
  message: PAYMENT_EXPIRED_REASON,
  recoverable: false,
};

const SALE_EXPIRED_FAILURE: WithdrawalFailure = {
  kind: "sale-expired",
  step: "payment",
  message: "The sale expired before it was completed",
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
      return "sale" in observation ? applySale(record, observation) : record;
    case "core":
      return record;
  }
}

/** Sent is terminal: of what an observation changed, only the witnesses, the rail, a sale's
 *  residue on its way home and `confirmedAt` are kept. */
function sentOnly(record: WithdrawalRecord, next: WithdrawalRecord): WithdrawalRecord {
  return {
    ...record,
    witnesses: next.witnesses,
    rail: next.rail,
    ...(next.residue === undefined ? {} : { residue: next.residue }),
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

/** The request is complete: the PAS is where the user asked for it. */
function sent(record: WithdrawalRecord, at: number): WithdrawalRecord {
  return {
    ...record,
    status: { kind: "sent", at },
    rail: { ...record.rail, stage: "delivered", updatedAt: at },
  };
}

/** The PAS is on Asset Hub: the request is complete when the destination is Asset Hub itself;
 *  otherwise the rail's leg begins, with nothing handed to the provider yet. */
function arrived(record: WithdrawalRecord, at: number): WithdrawalRecord {
  if (record.rail.provider === "direct") return sent(record, at);
  return {
    ...record,
    status: { kind: "sending", at },
    rail: { ...record.rail, updatedAt: at },
  };
}

/** The provider's endings, in the withdrawal's own names; anything else is unknown. */
function railFailureKind(kind: FailureKind): WithdrawalFailureKind {
  switch (kind) {
    case "deposit-rejected":
    case "egress-failed":
    case "fallback-egress":
    case "refunded":
      return kind;
    default:
      return "unknown";
  }
}

/** The provider's word on the swap, folded onto the rail: delivered completes the request, a
 *  failure ends the rail leg, and only a refund can be tried again. */
function railRead(
  record: WithdrawalRecord,
  reading: NonNullable<WithdrawJobView["rail"]>,
  at: number,
): WithdrawalRecord {
  if (record.rail.provider === "direct") return record;
  const rail = mergeRail(record.rail, railFromSwapStatus(record.rail.provider, reading, at));
  if (rail === record.rail) return record;
  const next = { ...record, rail };
  const rank = withdrawalRankOf(next);
  if (rail.stage === "delivered") return rank < 4 && !atSideExit(next) ? sent(next, at) : next;
  if (rail.stage === "failed" && rail.failure !== undefined) {
    if (rank >= 4 || atSideExit(next)) return next;
    return failed(next, at, {
      kind: railFailureKind(rail.failure.kind),
      step: "send",
      message: rail.failure.message,
      recoverable: rail.failure.kind === "refunded",
    });
  }
  return next;
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

/** The worker's failures that end a sale before its provider is paid, with the key going home. */
const SALE_ENDING_FAILURES: ReadonlySet<string> = new Set([
  "channel-expired",
  "channel-mismatch",
  "rejected",
  "timeout",
  "no-rail",
]);

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
  if (job.residue !== undefined && !sameResidue(record.residue, job.residue)) {
    next = { ...next, residue: job.residue };
  }
  if (job.fundsSeenAt !== null) next = paidSeen(next, job.fundsSeenAt, "worker");
  // The message leg is done: the PAS reached Asset Hub. Only a record short of the rail leg moves.
  if ((job.landed || job.done) && withdrawalRankOf(next) < 3) next = arrived(next, at);
  if (job.rail !== undefined) next = railRead(next, job.rail, at);
  const rank = withdrawalRankOf(next);
  if (job.phase === "failed") {
    if (atSideExit(next)) return next;
    // A sale has one order, opened once: a failure before its provider is paid ends it, and the
    // worker sends the key's funds home rather than trying the same order again.
    if (next.rail.provider === "meld" && SALE_ENDING_FAILURES.has(job.failure ?? "")) {
      return failed(next, at, {
        kind: "sale-closed",
        step: rank >= 3 ? "send" : "convert",
        message: job.lastError ?? "the sale could not be completed before its provider was paid",
        recoverable: false,
      });
    }
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
      case "held":
        // The PSM refused the redeem three times with room for it, so waiting cannot clear it.
        // The CASH is still on the key; a retry re-arms the worker's count.
        if (rank < 1) return next;
        return failed(next, at, {
          kind: "held",
          step: "convert",
          message: job.lastError ?? "the PSM would not redeem the CASH",
          recoverable: true,
        });
      case "expired":
        return rank === 0 && !paymentTaken(next) ? expired(next, at) : next;
      case "channel-expired":
        // The provider closed the channel before the key paid it, so nothing moved. A retry
        // opens a fresh one for what is still sitting on the key.
        return failed(next, at, {
          kind: "channel-expired",
          step: "send",
          message: job.lastError ?? "the provider closed the channel before it was paid",
          recoverable: true,
        });
      case "channel-mismatch":
        // The provider's own record of the channel disagreed with the withdrawal, so the key
        // never paid it. A retry opens a fresh channel from the record's own details.
        return failed(next, at, {
          kind: "channel-mismatch",
          step: "send",
          message: job.lastError ?? "the provider's channel did not match this withdrawal",
          recoverable: true,
        });
      case "no-rail":
        // Nothing in this build can carry the PAS on; the provider's reading, when there is
        // one, already spoke above.
        return failed(next, at, {
          kind: "unknown",
          step: "send",
          message: job.lastError ?? "no provider can carry this withdrawal in this build",
          recoverable: false,
        });
      case "unfundable":
        // The price moved past what the sale promised its provider before anything left People.
        // The worker sends the CASH home.
        if (rank < 1) return next;
        return failed(next, at, {
          kind: "unfundable",
          step: "convert",
          message: job.lastError ?? "the sale can no longer pay what it promised the provider",
          recoverable: false,
        });
      case "unresolved":
        // Whether the provider was paid cannot be told, so nothing more is sent from the key.
        return failed(next, at, {
          kind: "unresolved",
          step: "send",
          message: job.lastError ?? "the payment to the provider could not be confirmed",
          recoverable: false,
        });
      default:
        return next;
    }
  }
  // The worker finished following the provider: delivered, whatever its last reading said.
  if (job.done && rank < 4 && !atSideExit(next)) return sent(next, at);
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

const sameResidue = (
  a: WithdrawalRecord["residue"],
  b: NonNullable<WithdrawalRecord["residue"]>,
): boolean =>
  a !== undefined &&
  a.amount === b.amount &&
  a.returning === b.returning &&
  a.whole === b.whole &&
  a.returned === b.returned &&
  a.stuck === b.stuck;

/** The adapter's endings for a sale the purse was not asked for. */
const SALE_ENDINGS: Readonly<Record<string, string>> = Object.freeze({
  failed: "The provider ended the sale.",
  refused: "The provider did not accept the sale.",
  unobserved: "The provider did not confirm the sale.",
});

/**
 * The provider's order, read by the page until the purse is asked. The first deposit address it
 * names becomes the channel; an order that ends before the purse is asked ends the record, and
 * nothing was taken, as does one that no longer names that address and those terms. Once the
 * purse is asked the worker follows the sale, and these reads only keep its status.
 */
function applySale(record: WithdrawalRecord, observation: SaleObservation): WithdrawalRecord {
  const { sale } = record;
  if (sale === undefined || record.rail.provider !== "meld") return record;
  const { at, sale: reading } = observation;
  const status = { status: reading.status, providerStatus: reading.providerStatus };
  const unchanged = sale.status === status.status && sale.providerStatus === status.providerStatus;
  const next: WithdrawalRecord = unchanged
    ? record
    : {
        ...record,
        sale: {
          ...sale,
          status: reading.status,
          ...(reading.providerStatus === undefined
            ? {}
            : { providerStatus: reading.providerStatus }),
        },
      };
  if (!saleBeforePurse(next)) return next;
  // The provider changed the deposit after it disclosed it, its address or its terms: the sale
  // cannot be paid as agreed, whether or not this page took the first one.
  if (reading.depositConflictAt !== undefined) {
    return failed(next, at, {
      kind: "sale-mismatch",
      step: "payment",
      message: "The provider changed the deposit after showing it.",
      recoverable: false,
    });
  }
  const { channel } = next.handoff;
  if (reading.deposit !== undefined && channel === undefined) {
    return depositKnown(next, reading.deposit, at);
  }
  if (reading.status === "expired") return expired(next, at);
  const ending = SALE_ENDINGS[reading.status];
  if (ending !== undefined) {
    return failed(next, at, {
      kind: "sale-ended",
      step: "payment",
      message: ending,
      recoverable: false,
    });
  }
  // The address taken must still be the provider's word. The adapter stops naming one the
  // provider moved away from and shows the terms the provider states now, so a deposit that is
  // gone or changed ends the sale before anything is asked of the purse.
  if (channel !== undefined && !sameDeposit(channel, reading.deposit, saleTokenOf(next))) {
    return failed(next, at, {
      kind: "sale-mismatch",
      step: "payment",
      message: "The provider no longer names the deposit address and terms the sale took.",
      recoverable: false,
    });
  }
  return next;
}

/** The token a sale sells: the one the hand-off's sale lands on the key. */
const saleTokenOf = (record: WithdrawalRecord): TokenSpec =>
  depositTokenOf(recordedRoute(record.handoff));

/** Whether `deposit` is the channel's address, for the sale's `token` and its exact amount. */
function sameDeposit(
  channel: WithdrawalChannel,
  deposit: MeldSaleReading["deposit"],
  token: TokenSpec,
): boolean {
  return (
    deposit !== undefined &&
    deposit.address === channel.address &&
    deposit.currency === token.meldCurrencyCode &&
    parseBaseUnits(token, deposit.amount) === BigInt(channel.amount ?? "0")
  );
}

/**
 * The provider named where the crypto goes. It must be for the asset and the exact amount the
 * sale agreed, or the key never pays it. The sale's own window stands: the seller may come back to
 * it later, and the payment window starts when the purse is asked.
 */
function depositKnown(
  record: WithdrawalRecord,
  deposit: NonNullable<MeldSaleReading["deposit"]>,
  at: number,
): WithdrawalRecord {
  const sale = record.sale!;
  const token = saleTokenOf(record);
  const expected = BigInt(sale.cryptoAmount);
  const asked = parseBaseUnits(token, deposit.amount);
  if (deposit.currency !== token.meldCurrencyCode || asked !== expected) {
    return failed(record, at, {
      kind: "sale-mismatch",
      step: "payment",
      message: `The provider asked for ${deposit.amount} ${deposit.currency}, not the agreed amount.`,
      recoverable: false,
    });
  }
  const channel: WithdrawalChannel = {
    id: sale.fundingRequestId,
    address: deposit.address,
    openedAt: at,
    // Set when the purse is asked: from then on the key has SALE_PAY_WINDOW_MS to pay.
    expiresAt: 0,
    // The payout is fiat, paid off chain: nothing on chain checks it.
    expectedEgress: "0",
    amount: sale.cryptoAmount,
  };
  return { ...record, handoff: { ...record.handoff, channel } };
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

/** The payment window closed with nothing on the key. A sale whose purse was never asked says so
 *  instead. */
function expired(record: WithdrawalRecord, at: number): WithdrawalRecord {
  const unasked = record.sale !== undefined && record.payment.requestedAt === undefined;
  const failure = unasked ? SALE_EXPIRED_FAILURE : EXPIRED_FAILURE;
  return { ...record, status: { kind: "expired", at }, failure };
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
      const asked: WithdrawalRecord = { ...record, payment: { attempt, requestedAt: at, id } };
      if (record.sale === undefined) return asked;
      // A sale's payment window starts here, on the record's clock and on the hand-off the worker
      // is sent next: the seller may have come back to the provider's address long after it was
      // named. So does the time the key has to pay the provider, since Meld names none.
      const paymentExpiresAt = at + PAYMENT_WINDOW_MS;
      const { channel } = record.handoff;
      return {
        ...asked,
        deadline: { paymentExpiresAt },
        handoff: {
          ...record.handoff,
          paymentExpiresAt,
          ...(channel === undefined
            ? {}
            : { channel: { ...channel, expiresAt: at + SALE_PAY_WINDOW_MS } }),
        },
      };
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
      if (record.failure?.step === "send") {
        // The PAS is back on the key: the rail leg starts over with a fresh channel.
        return {
          ...rest,
          status: { kind: "sending", at },
          rail: { provider: record.rail.provider, stage: "waiting", updatedAt: at },
        };
      }
      const worker = record.witnesses.worker;
      const step: SendingStep =
        worker?.known && isSendingStep(worker.phase) ? worker.phase : "swap";
      return { ...rest, status: { kind: "converting", at, step } };
    }
    case "channel-opened":
      // A fresh channel for the rail leg; the hand-off the worker is re-armed with carries it.
      return { ...record, handoff: { ...record.handoff, channel: observation.channel } };
    case "sale-unfundable":
      // Only before the purse was asked: after that the worker's own floor decides.
      if (
        record.sale === undefined ||
        record.status.kind !== "awaiting-payment" ||
        record.payment.requestedAt !== undefined ||
        paymentTaken(record)
      ) {
        return record;
      }
      return failed(record, at, {
        kind: "unfundable",
        step: "payment",
        message: "the price moved past what the sale promised its provider",
        recoverable: false,
      });
    case "meld-submitted":
    case "deposit-skipped":
    case "deposit-accepted":
      return record;
  }
}
