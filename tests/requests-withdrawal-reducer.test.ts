// The withdrawal transition table through the reducer: one `it` per transition, plus the
// migration of a stored withdrawal.

import { describe, expect, it } from "vitest";
import type { SwapStatusResult } from "@getsome/core";
import { migrateRecord } from "../app/funding/requests/migrate";
import {
  PAYMENT_EXPIRED_REASON,
  PAYMENT_WINDOW_MS,
  type Observation,
  type WithdrawJobView,
  type WithdrawalRecord,
} from "../app/funding/requests/model";
import { reduce } from "../app/funding/requests/reducer";
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
    schema: 2,
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
  landed: false,
  done: false,
  fundsSeenAt: null,
  lastTickAt: null,
  ...overrides,
});
/** A provider reading, as the worker relays it. */
const reading = (status: SwapStatusResult["status"], extra: Partial<SwapStatusResult> = {}) =>
  ({ status, ...extra }) as SwapStatusResult;
/** A withdrawal to a Chainflip destination whose prompt returned. */
const railed = () =>
  record({
    payment: { attempt: 0, requestedAt: at(0), id: "pay-1" },
    rail: { provider: "chainflip", stage: "waiting", updatedAt: STARTED },
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

  it("completes a direct withdrawal on done, and hands a railed one to the rail on landing", () => {
    const seen = at(1);
    const direct = run(
      prompted(),
      worker(at(3), job({ phase: "done", landed: true, done: true, fundsSeenAt: seen })),
    );
    expect(direct.status).toEqual({ kind: "sent", at: at(3) });
    expect(direct.rail.stage).toBe("delivered");

    // The PAS is on the key's Asset Hub account; the worker opens the provider's channel next.
    const sending = run(
      railed(),
      worker(at(3), job({ phase: "handoff", landed: true, fundsSeenAt: seen })),
    );
    expect(sending.status).toEqual({ kind: "sending", at: at(3) });
    expect(sending.rail).toEqual({ provider: "chainflip", stage: "waiting", updatedAt: at(3) });
  });

  it("follows the provider's word on the rail leg to sent", () => {
    const seen = at(1);
    const landed = job({ phase: "follow", landed: true, fundsSeenAt: seen });
    const swapping = run(railed(), worker(at(3), { ...landed, rail: reading("swapping") }));
    expect(swapping.status).toEqual({ kind: "sending", at: at(3) });
    expect(swapping.rail).toMatchObject({ stage: "processing", status: "swapping" });

    // A read that says the same again moves nothing but the witness: the rail is kept as is.
    const same = run(swapping, worker(at(4), { ...landed, rail: reading("swapping") }));
    expect(same.rail).toBe(swapping.rail);
    expect(same.status).toEqual(swapping.status);

    // The stage never moves backwards on a stale read.
    const stale = run(swapping, worker(at(5), { ...landed, rail: reading("receiving") }));
    expect(stale.rail.stage).toBe("processing");

    const delivered = run(swapping, worker(at(6), { ...landed, rail: reading("complete") }));
    expect(delivered.status).toEqual({ kind: "sent", at: at(6) });
    expect(delivered.rail.stage).toBe("delivered");

    // The worker's done is a delivery too, whatever its last reading was.
    const done = run(
      swapping,
      worker(at(6), job({ phase: "done", landed: true, done: true, fundsSeenAt: seen })),
    );
    expect(done.status).toEqual({ kind: "sent", at: at(6) });
  });

  it("fails the rail leg on the provider's verdict, retryable only after a refund", () => {
    const seen = at(1);
    const following = run(
      railed(),
      worker(
        at(3),
        job({ phase: "follow", landed: true, fundsSeenAt: seen, rail: reading("swapping") }),
      ),
    );
    const refunded = run(
      following,
      worker(
        at(4),
        job({
          phase: "failed",
          failure: "rail-failed",
          landed: true,
          fundsSeenAt: seen,
          rail: reading("failed"),
        }),
      ),
    );
    expect(refunded.status).toEqual({ kind: "failed", at: at(4), recoverable: true });
    expect(refunded.failure).toMatchObject({ kind: "refunded", step: "send" });
    expect(refunded.rail.stage).toBe("failed");

    // A retry starts the rail leg over with a fresh channel.
    const again = run(refunded, { source: "user", at: at(5), event: "retry" });
    expect(again.status).toEqual({ kind: "sending", at: at(5) });
    expect(again.rail).toEqual({ provider: "chainflip", stage: "waiting", updatedAt: at(5) });
    expect(again.failure).toBeUndefined();

    const stuck = run(
      following,
      worker(
        at(4),
        job({
          phase: "failed",
          failure: "rail-failed",
          landed: true,
          fundsSeenAt: seen,
          rail: reading("sending", { swapEgressFailure: { reason: { message: "egress broke" } } }),
        }),
      ),
    );
    expect(stuck.status).toEqual({ kind: "failed", at: at(4), recoverable: false });
    expect(stuck.failure).toMatchObject({
      kind: "egress-failed",
      step: "send",
      message: "egress broke",
    });
    expect(run(stuck, { source: "user", at: at(5), event: "retry" })).toBe(stuck);
  });

  it("fails the rail leg plainly when the build has no provider for it", () => {
    const seen = at(1);
    const none = run(
      railed(),
      worker(
        at(3),
        job({
          phase: "failed",
          failure: "no-rail",
          landed: true,
          fundsSeenAt: seen,
          lastError: "no chainflip provider in this build",
        }),
      ),
    );
    expect(none.status).toEqual({ kind: "failed", at: at(3), recoverable: false });
    expect(none.failure).toMatchObject({
      kind: "unknown",
      step: "send",
      message: "no chainflip provider in this build",
    });
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
});
