// The withdrawal transition table through the reducer: one `it` per transition, plus the
// migration of a stored withdrawal.

import { describe, expect, it } from "vitest";
import type { SwapStatusResult } from "@getsome/core";
import type { MeldDepositDisclosure } from "@getsome/meld";
import { migrateRecord } from "../app/funding/requests/migrate";
import {
  PAYMENT_EXPIRED_REASON,
  PAYMENT_WINDOW_MS,
  type Observation,
  type WithdrawJobView,
  type WithdrawalRecord,
} from "../app/funding/requests/model";
import { reduce } from "../app/funding/requests/reducer";
import { browserSettlementObservations } from "../app/withdraw/meld-sell";
import { requestRefOf } from "../app/utils/request-index";

const MINUTE = 60_000;
const STARTED = Date.UTC(2026, 8, 17, 10, 0, 0);
/** Minutes after the start. */
const at = (minutes: number) => STARTED + minutes * MINUTE;

const REF = requestRefOf("wd:pas-assethub", 4);
const KEY_HEX = `0x${"07".repeat(32)}`;
const LANDING_HEX = `0x${"aa".repeat(32)}`;
const CASH = "21000000";

function record(overrides: Partial<WithdrawalRecord> = {}): WithdrawalRecord {
  return {
    schema: 3,
    kind: "withdrawal",
    ref: REF,
    rev: 0,
    updatedAt: STARTED,
    startedAt: STARTED,
    amountHuman: "21",
    route: "crypto",
    destination: {
      chain: "Asset Hub",
      asset: "PAS",
      address: "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5",
    },
    key: {
      label: "wd:eph:pas-assethub:4",
      address: "1jN9roH2QfHPSCurNcuCz4V58fXS2HPTGidJGQnT7dPthdZ",
      publicKeyHex: KEY_HEX,
    },
    payment: { attempt: 0 },
    deadline: { paymentExpiresAt: STARTED + PAYMENT_WINDOW_MS },
    handoff: {
      label: "wd:eph:pas-assethub:4",
      keyAddress: "1jN9roH2QfHPSCurNcuCz4V58fXS2HPTGidJGQnT7dPthdZ",
      keyPublicKeyHex: KEY_HEX,
      amount: CASH,
      destination: {
        chain: "Asset Hub",
        asset: "PAS",
        address: "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5",
      },
      landingHex: LANDING_HEX,
      rail: "direct",
      assetHubGenesis: "0xah",
      peopleGenesis: "0xpe",
      peopleParaId: 1004,
      assetHubParaId: 1000,
      poolAccount: "5Di1GihZ1G2dYzfD7gv2DLEzFvRMBLas3jXGLeicVCFFtr8B",
      slippagePct: 5,
      paymentExpiresAt: STARTED + PAYMENT_WINDOW_MS,
    },
    status: { kind: "awaiting-payment" },
    rail: { provider: "direct", stage: "waiting", updatedAt: STARTED },
    witnesses: {},
    ...overrides,
  };
}

/** A record whose prompt returned: attempt 0 under the host's id. */
const prompted = () => record({ payment: { attempt: 0, requestedAt: at(0), id: "pay-1" } });

const job = (overrides: Partial<WithdrawJobView> = {}): WithdrawJobView => ({
  phase: "await-cash",
  done: false,
  fundsSeenAt: null,
  lastTickAt: null,
  ...overrides,
});
const worker = (time: number, view: WithdrawJobView | null): Observation => ({
  source: "worker",
  at: time,
  withdrawJob: view,
});
const host = (
  time: number,
  status: "processing" | "completed" | "failed" | "partiallyClaimed" | "not-found",
  extra: { attempt?: number; reason?: string; actualClaimed?: string } = {},
): Observation => ({
  source: "host",
  at: time,
  payment: { attempt: extra.attempt ?? 0, status, ...extra },
});
const chain = (time: number, keyCash: string): Observation => ({
  source: "chain",
  at: time,
  keyCash,
  finality: "best",
  via: "probe",
});
const clock = (time: number): Observation => ({ source: "clock", at: time });
const cancelled = (time: number): Observation => ({
  source: "user",
  at: time,
  event: "cancelled",
  depositExpiresAt: 0,
});

const MELD_FUNDING_ID = "fr_1";
const COMMITTED = "5000000000";
const PROVIDER_PAYOUT = "13UVJyLnbVp9RBZYFwFGyDvVd1y27Tt8tkntv6Q7JVPhFsTB";
const DEPOSIT_ADDRESS = "16ZL8yLyXv3V3W3Q7q2yzP1QDeVzrY9367ZTt8tkntv6Q7JVP";

/** A withdrawal on the Meld rail, its sale not yet given a deposit address. */
function meldRecord(overrides: Partial<WithdrawalRecord> = {}): WithdrawalRecord {
  const base = record();
  return record({
    rail: {
      provider: "meld",
      stage: "waiting",
      updatedAt: STARTED,
      sale: {
        phase: "awaiting-deposit-address",
        meldFundingRequestId: MELD_FUNDING_ID,
        committedAmount: COMMITTED,
        quotedFiatAmount: "42.00",
        quotedFiatCurrency: "USD",
        sessionExpiresAt: STARTED + 30 * MINUTE,
      },
    },
    handoff: {
      ...base.handoff,
      rail: "meld",
      meld: {
        committedAmount: COMMITTED,
        providerPayoutAddress: PROVIDER_PAYOUT,
        orderRef: base.key.address,
      },
    },
    ...overrides,
  });
}

const meldDeposit = (observedAt: number, amount = COMMITTED): MeldDepositDisclosure => ({
  address: DEPOSIT_ADDRESS,
  amount,
  currency: "DOT_ASSETHUB",
  observedAt,
});

/** A provider poll, in the shape the reducer's `Observation` union carries: the normalised
 *  status, and the sell's deposit terms only on the polls that disclose them. */
function meldPoll(
  time: number,
  status: SwapStatusResult["status"],
  opts: { deposit?: MeldDepositDisclosure; raw?: string; message?: string } = {},
): Observation {
  const result: SwapStatusResult = {
    status,
    ...(opts.raw === undefined ? {} : { raw: opts.raw }),
    ...(status === "failed"
      ? { depositFailure: { reason: { message: opts.message ?? "the sale failed" } } }
      : {}),
  };
  return {
    source: "provider",
    at: time,
    provider: "meld",
    result,
    ...(opts.deposit === undefined ? {} : { deposit: opts.deposit }),
  };
}
const meldGone = (time: number, message: string): Observation => ({
  source: "provider",
  at: time,
  provider: "meld",
  gone: true,
  message,
});
const meldUnreachable = (time: number): Observation => ({
  source: "provider",
  at: time,
  provider: "meld",
  unreachable: true,
});

/** Reduces `observations` in order. */
const run = (start: WithdrawalRecord, ...observations: Observation[]): WithdrawalRecord =>
  observations.reduce(
    (current, observation) => reduce(current, observation),
    start as never,
  ) as WithdrawalRecord;

describe("withdrawal: the payment", () => {
  it("stamps the prompt with its attempt and id before it goes out, once per attempt", () => {
    const stamped = run(record(), {
      source: "user",
      at: at(0),
      event: "payment-requested",
      attempt: 0,
      id: "pay-1",
    });
    expect(stamped.payment).toEqual({ attempt: 0, requestedAt: at(0), id: "pay-1" });
    // A second command for the same attempt changes nothing; an older attempt is ignored.
    expect(
      run(stamped, {
        source: "user",
        at: at(1),
        event: "payment-requested",
        attempt: 0,
        id: "pay-1",
      }),
    ).toBe(stamped);
    const later = record({ payment: { attempt: 1 } });
    expect(
      run(later, { source: "user", at: at(1), event: "payment-requested", attempt: 0, id: "x" }),
    ).toBe(later);
  });

  it("follows the host's word: processing witnesses, completed pays, failed fails recoverably", () => {
    const processing = run(prompted(), host(at(1), "processing"));
    expect(processing.status).toEqual({ kind: "awaiting-payment" });
    expect(processing.payment.status).toBe("processing");
    expect(processing.witnesses.host).toEqual({ status: "processing", at: at(1) });

    const paid = run(processing, host(at(2), "completed"));
    expect(paid.status).toEqual({ kind: "paid", at: at(2), via: "host" });

    const failed = run(prompted(), host(at(2), "failed", { reason: "Declined" }));
    expect(failed.status).toEqual({ kind: "failed", at: at(2), recoverable: true });
    expect(failed.failure).toEqual({
      kind: "payment-failed",
      step: "payment",
      message: "Declined",
      recoverable: true,
    });
  });

  it("pays short with the amount the host says reached the key", () => {
    const partial = run(prompted(), host(at(2), "partiallyClaimed", { actualClaimed: "20000000" }));
    expect(partial.status).toEqual({ kind: "paid", at: at(2), via: "host" });
    expect(partial.paidAmount).toBe("20000000");
  });

  it("keeps the host's failure as a conflict once CASH was seen", () => {
    const paid = run(prompted(), chain(at(2), CASH));
    const conflicted = run(paid, host(at(3), "failed", { reason: "Declined" }));
    expect(conflicted.status).toEqual({ kind: "paid", at: at(2), via: "chain" });
    expect(conflicted.witnesses.conflict?.source).toBe("host");
  });

  it("ignores the host's word on another attempt beyond the witness", () => {
    const other = run(prompted(), host(at(2), "completed", { attempt: 1 }));
    expect(other.status).toEqual({ kind: "awaiting-payment" });
    expect(other.witnesses.host).toEqual({ status: "completed", at: at(2) });
  });

  it("retries a failed payment with a fresh attempt for the surface to prompt", () => {
    const failed = run(prompted(), host(at(2), "failed", { reason: "Declined" }));
    const again = run(failed, { source: "user", at: at(3), event: "retry" });
    expect(again.status).toEqual({ kind: "awaiting-payment" });
    expect(again.payment).toEqual({ attempt: 1 });
    expect(again.failure).toBeUndefined();
    // The payment window restarts with the attempt, on the record and on the hand-off.
    expect(again.deadline.paymentExpiresAt).toBe(at(3) + PAYMENT_WINDOW_MS);
    expect(again.handoff.paymentExpiresAt).toBe(at(3) + PAYMENT_WINDOW_MS);
  });
});

describe("withdrawal: money on the key", () => {
  it("is paid by any positive read, with the amount, and never unwound by a zero read", () => {
    const paid = run(prompted(), chain(at(2), CASH));
    expect(paid.status).toEqual({ kind: "paid", at: at(2), via: "chain" });
    expect(paid.paidAmount).toBe(CASH);
    expect(paid.witnesses.chain?.best).toEqual({ keyCash: CASH, at: at(2) });
    const zero = run(paid, chain(at(3), "0"));
    expect(zero.status).toEqual(paid.status);
  });

  it("resurrects a cancelled or expired request", () => {
    const tombstoned = run(prompted(), host(at(1), "failed"), cancelled(at(2)));
    expect(tombstoned.status.kind).toBe("cancelled");
    const back = run(tombstoned, chain(at(3), CASH));
    expect(back.status).toEqual({ kind: "paid", at: at(3), via: "chain" });
    expect(back.failure).toBeUndefined();
  });
});

describe("withdrawal: the worker", () => {
  it("notes an unknown job, and pays from a job that saw the CASH", () => {
    const unknown = run(prompted(), worker(at(1), null));
    expect(unknown.witnesses.worker).toEqual({ known: false, at: at(1) });
    const paid = run(unknown, worker(at(2), job({ fundsSeenAt: at(1) + 30_000 })));
    expect(paid.status).toEqual({ kind: "paid", at: at(1) + 30_000, via: "worker" });
    expect(paid.confirmedAt).toBe(at(2));
  });

  it("carries the conversion through the worker's steps in order and never backwards", () => {
    const seen = at(1);
    const swapping = run(prompted(), worker(at(2), job({ phase: "swap", fundsSeenAt: seen })));
    expect(swapping.status).toEqual({ kind: "converting", at: at(2), step: "swap" });
    const arriving = run(
      swapping,
      worker(at(3), job({ phase: "await-arrival", fundsSeenAt: seen })),
    );
    expect(arriving.status).toEqual({ kind: "converting", at: at(3), step: "await-arrival" });
    const stale = run(arriving, worker(at(4), job({ phase: "convert", fundsSeenAt: seen })));
    expect(stale.status).toEqual(arriving.status);
  });

  it("completes a direct withdrawal on done, and hands a railed one to the rail", () => {
    const seen = at(1);
    const direct = run(
      prompted(),
      worker(at(3), job({ phase: "done", done: true, fundsSeenAt: seen })),
    );
    expect(direct.status).toEqual({ kind: "sent", at: at(3) });
    expect(direct.rail.stage).toBe("delivered");

    const railed = record({
      payment: { attempt: 0, requestedAt: at(0), id: "pay-1" },
      rail: { provider: "chainflip", stage: "waiting", updatedAt: STARTED },
    });
    const sending = run(
      railed,
      worker(at(3), job({ phase: "done", done: true, fundsSeenAt: seen })),
    );
    expect(sending.status).toEqual({ kind: "sending", at: at(3) });
    expect(sending.rail.stage).toBe("delivering");
  });

  it("fails recoverably on a rejection or a timeout", () => {
    const seen = at(1);
    const rejected = run(
      prompted(),
      worker(at(3), job({ phase: "failed", failure: "rejected", fundsSeenAt: seen })),
    );
    expect(rejected.status).toEqual({ kind: "failed", at: at(3), recoverable: true });
    expect(rejected.failure?.step).toBe("convert");
  });

  it("expires an unpaid request on the worker's word, but not one the host took", () => {
    const expired = run(prompted(), worker(at(40), job({ phase: "failed", failure: "expired" })));
    expect(expired.status).toEqual({ kind: "expired", at: at(40) });
    expect(expired.failure?.message).toBe(PAYMENT_EXPIRED_REASON);

    const taken = run(prompted(), host(at(1), "processing"));
    const kept = run(taken, worker(at(40), job({ phase: "failed", failure: "expired" })));
    expect(kept.status).toEqual({ kind: "awaiting-payment" });
  });

  it("retries a failed conversion at the worker's last step", () => {
    const seen = at(1);
    const rejected = run(
      prompted(),
      worker(at(2), job({ phase: "convert", fundsSeenAt: seen })),
      worker(at(3), job({ phase: "failed", failure: "rejected", fundsSeenAt: seen })),
    );
    const again = run(rejected, { source: "user", at: at(4), event: "retry" });
    expect(again.status).toEqual({ kind: "converting", at: at(4), step: "swap" });
    expect(again.failure).toBeUndefined();
  });
});

describe("withdrawal: the return", () => {
  const unwindReturn = (overrides: Partial<NonNullable<WithdrawJobView["return"]>> = {}) => ({
    reason: "unwind" as const,
    phase: "await-native",
    returned: false,
    returnedAmount: null,
    nativeSeen: null,
    claim: null,
    txs: [],
    ...overrides,
  });

  it("carries the return onto the record without moving status, failure or done", () => {
    // The return never writes phase/done/failure (see WithdrawalReturnView's header): a failed
    // sale stays failed even once its return object says money came back.
    const failed = run(
      prompted(),
      worker(at(3), job({ phase: "failed", failure: "timeout", fundsSeenAt: at(1) })),
      worker(at(4), job({ phase: "failed", failure: "timeout", return: unwindReturn() })),
    );
    expect(failed.status.kind).toBe("failed");
    expect(failed.failure?.kind).toBe("timeout");
    expect(failed.return).toEqual(unwindReturn());
  });

  it("never reads sent once the return finishes, however complete the unwind is", () => {
    const returned = unwindReturn({ phase: "done", returned: true, returnedAmount: "21000000" });
    const failed = run(
      prompted(),
      worker(at(3), job({ phase: "failed", failure: "rejected", fundsSeenAt: at(1) })),
      worker(at(4), job({ phase: "failed", failure: "rejected", return: returned })),
    );
    expect(failed.status.kind).not.toBe("sent");
    expect(failed.status.kind).toBe("failed");
    expect(failed.return?.returned).toBe(true);
  });

  it("keeps a residue's return moving even once the sale itself already reads sent", () => {
    // `sentOnly` trims a sent record to its witnesses, rail and confirmedAt -- the return must
    // survive that trim, since the residue leg only starts once the sale is already done.
    const sent = run(
      prompted(),
      worker(at(3), job({ phase: "done", done: true, fundsSeenAt: at(1) })),
    );
    expect(sent.status).toEqual({ kind: "sent", at: at(3) });
    expect(sent.return).toBeUndefined();

    const withResidue = run(
      sent,
      worker(
        at(5),
        job({
          phase: "done",
          done: true,
          fundsSeenAt: at(1),
          return: {
            reason: "residue",
            phase: "done",
            returned: true,
            returnedAmount: "150000",
            nativeSeen: null,
            claim: { amount: "150000", status: "claimed", partial: false },
            txs: [],
          },
        }),
      ),
    );
    expect(withResidue.status).toEqual({ kind: "sent", at: at(3) }); // untouched by sentOnly
    expect(withResidue.return?.reason).toBe("residue");
    expect(withResidue.return?.returned).toBe(true);
    expect(withResidue.return?.returnedAmount).toBe("150000");
  });

  it("keeps the return once set, even when a later poll happens not to repeat it", () => {
    const withReturn = run(
      prompted(),
      worker(at(3), job({ phase: "failed", failure: "timeout", return: unwindReturn() })),
    );
    expect(withReturn.return).toEqual(unwindReturn());
    const again = run(
      withReturn,
      worker(at(4), job({ phase: "failed", failure: "timeout" })), // no `return` this time
    );
    expect(again.return).toEqual(unwindReturn());
  });
});

describe("withdrawal: the clock and the user", () => {
  it("expires an unpaid request past its window, and never one the host has in hand", () => {
    const late = at(31);
    expect(run(prompted(), clock(late)).status).toEqual({ kind: "expired", at: late });
    expect(run(prompted(), clock(at(29))).status).toEqual({ kind: "awaiting-payment" });
    const processing = run(prompted(), host(at(1), "processing"));
    expect(run(processing, clock(late)).status).toEqual({ kind: "awaiting-payment" });
    // A prompt the host never registered expires like an unprompted one.
    const unanswered = run(prompted(), host(at(1), "not-found"));
    expect(run(unanswered, clock(late)).status).toEqual({ kind: "expired", at: late });
  });

  it("cancels only while nothing was paid or taken", () => {
    expect(run(record(), cancelled(at(1))).status).toEqual({ kind: "cancelled", at: at(1) });
    const processing = run(prompted(), host(at(1), "processing"));
    expect(run(processing, cancelled(at(2))).status).toEqual({ kind: "awaiting-payment" });
    const paid = run(prompted(), chain(at(1), CASH));
    expect(run(paid, cancelled(at(2))).status).toEqual(paid.status);
    const failedPayment = run(prompted(), host(at(1), "failed"));
    expect(run(failedPayment, cancelled(at(2))).status).toEqual({ kind: "cancelled", at: at(2) });
  });
});

describe("withdrawal: the Meld rail", () => {
  it("carries a Meld withdrawal through its full happy path", () => {
    const start = meldRecord({ payment: { attempt: 0, requestedAt: at(0), id: "pay-1" } });
    const paid = run(start, host(at(1), "completed"));
    expect(paid.status).toEqual({ kind: "paid", at: at(1), via: "host" });

    // KYC concludes mid-conversion: the deposit address arrives.
    const converting = run(
      paid,
      worker(at(2), job({ phase: "swap", fundsSeenAt: at(1) })),
      meldPoll(at(3), "waiting", { deposit: meldDeposit(at(3)) }),
    );
    expect(converting.status).toEqual({ kind: "converting", at: at(2), step: "swap" });
    expect(converting.rail.sale?.phase).toBe("deposit-known");
    if (converting.rail.sale?.phase === "deposit-known") {
      expect(converting.rail.sale.deposit).toEqual(meldDeposit(at(3)));
    }

    // The chain legs land the committed amount at the provider: rank 3, "sending".
    const sending = run(
      converting,
      worker(at(5), job({ phase: "pay-provider", fundsSeenAt: at(1) })),
      worker(at(6), job({ phase: "done", done: true, fundsSeenAt: at(1) })),
    );
    expect(sending.status).toEqual({ kind: "sending", at: at(6) });
    expect(sending.rail.stage).toBe("delivering");

    // The provider's own payout settles: only now is the withdrawal sent.
    const sent = run(sending, meldPoll(at(8), "complete"));
    expect(sent.status).toEqual({ kind: "sent", at: at(8) });
    expect(sent.rail.stage).toBe("delivered");
  });

  it("browser-mock observations carry a disclosed Meld sale to sent", () => {
    const known = run(meldRecord(), meldPoll(at(1), "waiting", { deposit: meldDeposit(at(1)) }));
    expect(known.rail.sale?.phase).toBe("deposit-known");
    const [funded, done] = browserSettlementObservations(at(2), at(3));
    const sending = run(known, funded, done);
    expect(sending.status.kind).toBe("sending");
    const sent = run(sending, meldPoll(at(4), "complete"));
    expect(sent.status).toEqual({ kind: "sent", at: at(4) });
    expect(sent.rail.stage).toBe("delivered");
  });

  it("keeps the deposit address once known, even once the adapter stops disclosing it", () => {
    const known = run(meldRecord(), meldPoll(at(1), "waiting", { deposit: meldDeposit(at(1)) }));
    expect(known.rail.sale?.phase).toBe("deposit-known");
    // The adapter withholds the disclosure once the request has moved further along; the
    // record must not forget the address it already has.
    const later = run(known, meldPoll(at(2), "receiving"));
    expect(later.rail.sale?.phase).toBe("deposit-known");
    if (later.rail.sale?.phase === "deposit-known") {
      expect(later.rail.sale.deposit).toEqual(meldDeposit(at(1)));
    }
  });

  it("fails irrecoverably when the provider reports a failure after the crypto was sent", () => {
    const sending = run(
      meldRecord({ payment: { attempt: 0, requestedAt: at(0), id: "pay-1" } }),
      host(at(1), "completed"),
      worker(at(2), job({ phase: "done", done: true, fundsSeenAt: at(1) })),
    );
    expect(sending.status).toEqual({ kind: "sending", at: at(2) });
    const failed = run(sending, meldPoll(at(4), "failed", { message: "declined" }));
    expect(failed.status).toEqual({ kind: "failed", at: at(4), recoverable: false });
    // The provider's own reason survives verbatim: it is the only evidence support has for
    // telling "check Asset Hub" apart from "check Meld's dashboard" once the money is gone.
    expect(failed.failure).toEqual({
      kind: "unresolved",
      step: "send",
      message: "declined",
      recoverable: false,
    });
    expect(failed.rail.stage).toBe("failed");
    // Not retryable from here: the sale itself ended, and only a human can reconcile it.
    expect(run(failed, { source: "user", at: at(5), event: "retry" })).toBe(failed);
  });

  it("never resurrects a send-step side exit into sent on a late complete, and freezes once terminal", () => {
    const sending = run(
      meldRecord({ payment: { attempt: 0, requestedAt: at(0), id: "pay-1" } }),
      host(at(1), "completed"),
      worker(at(2), job({ phase: "done", done: true, fundsSeenAt: at(1) })),
    );
    const failedAtSend = run(sending, meldPoll(at(3), "failed", { message: "declined" }));
    expect(failedAtSend.status).toMatchObject({ kind: "failed" });
    expect(failedAtSend.failure?.step).toBe("send");

    // A late "complete" must not walk this back into "sent": rank 3 is ambiguous between the
    // live "sending" status and a send-step side exit, so the check is on the status kind.
    const late = run(failedAtSend, meldPoll(at(4), "complete"));
    expect(late.status).toEqual(failedAtSend.status);

    // And once there, the record is fully done with the rail: a repeat poll — even one with a
    // fresh reason — is a true no-op, not merely one whose status doesn't move.
    expect(run(failedAtSend, meldPoll(at(5), "failed", { message: "declined again" }))).toBe(
      failedAtSend,
    );
    expect(run(failedAtSend, meldGone(at(5), "still gone"))).toBe(failedAtSend);
  });

  it("never lets a stale failure or gone poll corrupt a sent record's rail", () => {
    const sent = run(
      meldRecord({ payment: { attempt: 0, requestedAt: at(0), id: "pay-1" } }),
      host(at(1), "completed"),
      worker(at(2), job({ phase: "done", done: true, fundsSeenAt: at(1) })),
      meldPoll(at(3), "complete"),
    );
    expect(sent.status).toEqual({ kind: "sent", at: at(3) });
    expect(sent.rail.stage).toBe("delivered");

    // A stale "failed" (or a "gone") arriving after the fact must not leave `sent` sitting next
    // to a `rail.stage === "failed"` with a populated failure nobody asked for.
    const stillSent = run(sent, meldPoll(at(1), "failed", { message: "declined" }));
    expect(stillSent).toBe(sent);
    expect(stillSent.rail.stage).toBe("delivered");
    expect(stillSent.failure).toBeUndefined();

    const alsoStillSent = run(sent, meldGone(at(9), "request not found"));
    expect(alsoStillSent).toBe(sent);
  });

  it("fails at every rank a provider failure can reach it at", () => {
    const awaitingPayment = run(meldRecord(), meldPoll(at(1), "failed", { message: "x" }));
    expect(awaitingPayment.status).toMatchObject({ kind: "failed" });
    expect(awaitingPayment.failure?.step).toBe("payment");
    expect(awaitingPayment.failure?.recoverable).toBe(false);

    const paid = run(
      meldRecord({ payment: { attempt: 0, requestedAt: at(0), id: "pay-1" } }),
      host(at(1), "completed"),
      meldPoll(at(2), "failed", { message: "x" }),
    );
    expect(paid.status).toMatchObject({ kind: "failed" });
    expect(paid.failure?.step).toBe("payment");

    const converting = run(
      meldRecord({ payment: { attempt: 0, requestedAt: at(0), id: "pay-1" } }),
      host(at(1), "completed"),
      worker(at(2), job({ phase: "swap", fundsSeenAt: at(1) })),
      meldPoll(at(3), "failed", { message: "x" }),
    );
    expect(converting.status).toMatchObject({ kind: "failed" });
    expect(converting.failure?.step).toBe("convert");
  });

  it("does not move the record backwards on an out-of-order provider poll", () => {
    // "complete" before the chain legs finish must not fast-forward past them.
    const early = run(meldRecord(), meldPoll(at(1), "complete"));
    expect(early.status).toEqual({ kind: "awaiting-payment" });

    // Once sent, a stale poll changes nothing but the rail's own bookkeeping.
    const sent = run(
      meldRecord({ payment: { attempt: 0, requestedAt: at(0), id: "pay-1" } }),
      host(at(1), "completed"),
      worker(at(2), job({ phase: "done", done: true, fundsSeenAt: at(1) })),
      meldPoll(at(3), "complete"),
    );
    expect(sent.status).toEqual({ kind: "sent", at: at(3) });
    const stale = run(sent, meldPoll(at(1), "receiving"));
    expect(stale.status).toEqual(sent.status);
  });

  it("refuses to cancel once the sale has a deposit address, even before payment", () => {
    const known = run(meldRecord(), meldPoll(at(1), "waiting", { deposit: meldDeposit(at(1)) }));
    expect(known.status).toEqual({ kind: "awaiting-payment" });
    expect(run(known, cancelled(at(2))).status).toEqual({ kind: "awaiting-payment" });
    // Before the address is known, a plain rank-0 cancel still works.
    expect(run(meldRecord(), cancelled(at(2))).status).toEqual({ kind: "cancelled", at: at(2) });
  });

  it("learns nothing but the witness from an unreachable poll, and fails irrecoverably when the adapter loses the request", () => {
    const start = meldRecord();
    const missed = run(start, meldUnreachable(at(1)));
    expect(missed.status).toEqual(start.status);
    expect(missed.rail).toEqual(start.rail);
    expect(missed.witnesses.provider).toEqual({ at: at(1) });

    const gone = run(start, meldGone(at(1), "request not found"));
    expect(gone.status).toEqual({ kind: "failed", at: at(1), recoverable: false });
    expect(gone.failure?.kind).toBe("unknown");
    expect(gone.failure?.step).toBe("payment");
  });

  it("drops a provider poll older than the last one, before it ever reaches the sale", () => {
    const known = run(meldRecord(), meldPoll(at(3), "waiting", { deposit: meldDeposit(at(3)) }));
    expect(known.witnesses.provider).toEqual({ at: at(3) });
    // Older than the last provider witness: reducer.ts drops it outright, so a deposit it
    // carries never even reaches `applyMeldResult`.
    const stale = reduce(known, meldPoll(at(2), "waiting", { deposit: meldDeposit(at(2), "1") }));
    expect(stale).toBe(known);
  });

  it("leaves a chainflip rail's own provider polls untouched, wired for Meld alone", () => {
    const railed = record({
      rail: { provider: "chainflip", stage: "waiting", updatedAt: STARTED },
    });
    const polled: Observation = {
      source: "provider",
      at: at(1),
      provider: "chainflip",
      result: { status: "complete" },
    };
    expect(reduce(railed, polled)).toBe(railed);
  });
});

describe("withdrawal: terminal and monotonic", () => {
  it("keeps only witnesses on a sent record", () => {
    const sent = run(
      prompted(),
      worker(at(3), job({ phase: "done", done: true, fundsSeenAt: at(1) })),
    );
    const later = run(sent, chain(at(5), CASH));
    expect(later.status).toEqual(sent.status);
    expect(later.witnesses.chain?.best?.keyCash).toBe(CASH);
    expect(later.witnesses.conflict?.note).toBe("CASH on a sent key");
    expect(later.paidAmount).toBeUndefined();
  });

  it("drops a host reading older than the last one", () => {
    const current = run(prompted(), host(at(3), "processing"));
    expect(run(current, host(at(2), "completed"))).toBe(current);
  });
});

describe("withdrawal: migration", () => {
  it("reads a stored withdrawal back and drops one missing what the reducer reads", () => {
    const stored = run(prompted(), chain(at(2), CASH));
    const back = migrateRecord(JSON.parse(JSON.stringify(stored)), REF, at(9));
    expect(back).not.toBeNull();
    // Taken as stored, witnesses included, as a top-up is.
    expect(back).toMatchObject({
      kind: "withdrawal",
      status: stored.status,
      payment: stored.payment,
      witnesses: stored.witnesses,
    });
    const { payment: _dropped, ...broken } = stored;
    expect(migrateRecord(broken, REF, at(9))).toBeNull();
  });

  it("migrates a schema-2 direct withdrawal to schema 3 and keeps it reducible", () => {
    const { schema: _s, ...rest } = prompted();
    const stored = { schema: 2, ...rest };
    const migrated = migrateRecord(JSON.parse(JSON.stringify(stored)), REF, at(9));
    expect(migrated).not.toBeNull();
    expect(migrated?.schema).toBe(3);
    expect(migrated).toMatchObject({
      kind: "withdrawal",
      status: stored.status,
      rail: { provider: "direct" },
    });
    expect(reduce(migrated!, chain(at(2), CASH)).status).toEqual({
      kind: "paid",
      at: at(2),
      via: "chain",
    });
  });

  it("migrates a schema-2 chainflip withdrawal to schema 3 and keeps it reducible", () => {
    const railed = record({
      payment: { attempt: 0, requestedAt: at(0), id: "pay-1" },
      rail: { provider: "chainflip", stage: "waiting", updatedAt: STARTED },
    });
    const { schema: _s, ...rest } = railed;
    const stored = { schema: 2, ...rest };
    const migrated = migrateRecord(JSON.parse(JSON.stringify(stored)), REF, at(9));
    expect(migrated).not.toBeNull();
    expect(migrated?.schema).toBe(3);
    expect(migrated).toMatchObject({
      kind: "withdrawal",
      status: stored.status,
      rail: { provider: "chainflip" },
    });
    const sending = reduce(migrated!, {
      source: "worker",
      at: at(2),
      withdrawJob: job({ phase: "done", done: true, fundsSeenAt: at(1) }),
    });
    expect(sending.status).toEqual({ kind: "sending", at: at(2) });
  });
});
