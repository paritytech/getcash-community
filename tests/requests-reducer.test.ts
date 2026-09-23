// The top-up transition table through the reducer: one `it` per transition of the design's table.

import { describe, expect, it } from "vitest";
import type { SwapStatusResult } from "@getsome/core";
import { migrateRecord } from "../app/funding/requests/migrate";
import {
  DEPOSIT_EXPIRED_REASON,
  FUNDING_HELD_REASON,
  PROVISIONAL_REVERT_MS,
  type Observation,
  type RequestRecord,
  type WorkerJobView,
} from "../app/funding/requests/model";
import { reduce } from "../app/funding/requests/reducer";
import type { ActiveFlowRecord } from "../app/stores/session";
import { requestRefOf, type RequestRef } from "../app/utils/request-index";
import {
  awaitingDepositCryptoRecord,
  cancelledCryptoRecord,
  failedCryptoRecord,
  FIXTURE_NOW,
  settledCardRecord,
  submittedCardRecord,
} from "./fixtures/requests";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Minutes after the fixture instant; every fixture event lies before it. */
const at = (minutes: number) => FIXTURE_NOW + minutes * MINUTE;

const CRYPTO_REF = requestRefOf("dot-assethub", 3);
const CARD_REF = requestRefOf("meld-card", 2);
const FUNDS = "250000000000";
const SHORTFALL = "shortfall: the deposit is below the swap minimum";
const DECLINED = "Your bank declined the payment. Check your card details or try another card.";
const declined: SwapStatusResult = {
  status: "failed",
  depositFailure: { reason: { code: "declined", message: DECLINED }, kind: "deposit-rejected" },
};
const RETURNED = "The deposit didn't go through. It is being returned to your recovery address.";
/** A Chainflip refund as `recordFailureReason` reports it through the provider path. */
const returned: SwapStatusResult = {
  status: "failed",
  depositFailure: { reason: { message: RETURNED }, kind: "refunded" },
};

/** A fixture as the reducer first sees it: migrated at the fixture instant. */
function migrated(record: ActiveFlowRecord, ref: RequestRef): RequestRecord {
  const result = migrateRecord(record, ref, FIXTURE_NOW);
  if (result === null) throw new Error("fixture did not migrate");
  return result;
}
const awaiting = () => migrated(awaitingDepositCryptoRecord, CRYPTO_REF);
const card = () => migrated(submittedCardRecord, CARD_REF);

/** A job as the store extracts it from the worker's blob. */
const job = (overrides: Partial<WorkerJobView> = {}): WorkerJobView => ({
  phase: "await-native",
  done: false,
  fundsSeenAt: null,
  lastTickAt: null,
  claim: null,
  ...overrides,
});
const worker = (time: number, view: WorkerJobView | null): Observation => ({
  source: "worker",
  at: time,
  job: view,
});
/** The worker's swap step, one minute after it saw the funds. */
const workerSwap = (seenAt: number): Observation =>
  worker(seenAt + MINUTE, job({ phase: "swap", fundsSeenAt: seenAt, lastTickAt: seenAt + MINUTE }));
const chain = (
  time: number,
  burnerNative: string,
  finality: "best" | "finalized",
  block?: number,
): Observation => ({
  source: "chain",
  at: time,
  burnerNative,
  finality,
  ...(block === undefined ? {} : { block }),
  via: "probe",
});
const clock = (time: number): Observation => ({ source: "clock", at: time });
const meld = (time: number, result: SwapStatusResult): Observation => ({
  source: "provider",
  at: time,
  provider: "meld",
  result,
});
const cancel = (time: number, depositExpiresAt = 0): Observation => ({
  source: "user",
  at: time,
  event: "cancelled",
  depositExpiresAt,
});
const coreDone = (time: number): Observation => ({
  source: "core",
  at: time,
  state: { phase: "done", sourceId: "dot-assethub", result: { id: 3, sourceId: "dot-assethub" } },
});

/** A crypto request the worker is converting: the deposit seen at +1, the swap step at +2. */
const converting = () => reduce(awaiting(), workerSwap(at(1)));

describe("request reducer: top-up transitions", () => {
  it("start record then worker swap → converting(swap) and cash-conversion stage", () => {
    const record = reduce(awaiting(), workerSwap(at(1)));
    expect(record.status).toEqual({ kind: "converting", at: at(2), step: "swap" });
    expect(record.funded).toBe(at(1));
    // The sighting completes the payment leg; the swap report starts the conversion stage.
    expect(record.progress.confirmedStageKey).toBe("cash-conversion");
    expect(record.progress.stageTimestamps["cash-conversion"]).toBe(at(2));
    expect(record.progress.detectedAt).toBe(at(1));
    expect(record.progress.routeCompletedAt).toBe(at(1));
    expect(record.witnesses.worker).toEqual({
      known: true,
      phase: "swap",
      done: false,
      fundsSeenAt: at(1),
      lastTickAt: at(2),
      at: at(2),
    });
    expect(record.confirmedAt).toBe(at(2));
    expect(record.updatedAt).toBe(at(2));
  });

  it("worker claimed → settled with claimed amount", () => {
    const claimed = job({
      phase: "done",
      done: true,
      fundsSeenAt: at(1),
      lastTickAt: at(10),
      claim: { phase: "claimed", amount: "25250000", at: at(10) },
    });
    const record = reduce(converting(), worker(at(11), claimed));
    expect(record.status).toEqual({ kind: "settled", at: at(10) });
    expect(record.settledAt).toBe(at(10));
    expect(record.claimed).toBe("25250000");
    expect(record.progress.settledAt).toBe(at(10));
    expect(record.progress.confirmedStageKey).toBe("cash-top-up");
    expect(record.witnesses.worker).toMatchObject({
      known: true,
      claimPhase: "claimed",
      at: at(11),
    });
  });

  it("core done → settled; later worker claimed only fills claimed", () => {
    const settled = reduce(converting(), coreDone(at(5)));
    expect(settled.status).toEqual({ kind: "settled", at: at(5) });
    expect(settled.settledAt).toBe(at(5));
    expect(settled.claimed).toBeUndefined();
    expect(settled.witnesses.core).toEqual({ phase: "done", at: at(5) });

    const claimed = job({
      phase: "done",
      done: true,
      fundsSeenAt: at(1),
      lastTickAt: at(6),
      claim: { phase: "claimed", amount: "25250000", at: at(6) },
    });
    const later = reduce(settled, worker(at(7), claimed));
    expect(later.status).toEqual({ kind: "settled", at: at(5) });
    expect(later.settledAt).toBe(at(5));
    expect(later.claimed).toBe("25250000");
    expect(later.confirmedAt).toBe(at(7));
    expect(later.updatedAt).toBe(at(7));
  });

  it("clock past deadline while rail waiting → expired with DEPOSIT_EXPIRED_REASON", () => {
    const record = awaiting();
    const deadline = awaitingDepositCryptoRecord.depositExpiresAt!;
    expect(record.deadline).toEqual({ depositExpiresAt: deadline, source: "rail" });
    expect(reduce(record, clock(deadline)).status).toEqual({ kind: "awaiting-deposit" });

    const expired = reduce(record, clock(deadline + 1));
    expect(expired.status).toEqual({ kind: "expired", at: deadline + 1 });
    expect(expired.failureReason).toBe(DEPOSIT_EXPIRED_REASON);
    expect(expired.failure).toEqual({
      kind: "expired",
      step: "deposit",
      message: DEPOSIT_EXPIRED_REASON,
      recoverable: false,
    });
    expect(expired.progress.failedAt).toBe(deadline + 1);
    expect(expired.witnesses.clock).toEqual({ at: deadline + 1 });
  });

  it("clock past deadline while rail received → no change", () => {
    const record = awaiting();
    const deadline = awaitingDepositCryptoRecord.depositExpiresAt!;
    const paid: RequestRecord = {
      ...record,
      rail: { ...record.rail, status: "receiving", stage: "received" },
    };
    const ticked = reduce(paid, clock(deadline + 1));
    expect(ticked.status).toEqual({ kind: "awaiting-deposit" });
    expect(ticked.failureReason).toBeUndefined();
    expect(ticked.failure).toBeUndefined();
    expect(ticked.progress.failedAt).toBeUndefined();
    expect(ticked.witnesses.clock).toEqual({ at: deadline + 1 });
  });

  it("user cancelled from awaiting-deposit → cancelled; from converting → no change", () => {
    const deadline = awaitingDepositCryptoRecord.depositExpiresAt!;
    const cancelled = reduce(awaiting(), cancel(at(1), deadline));
    expect(cancelled.status).toEqual({ kind: "cancelled", at: at(1) });
    expect(cancelled.cancelledAt).toBe(at(1));
    expect(cancelled.depositExpiresAt).toBe(deadline);
    expect(cancelled.updatedAt).toBe(at(1));

    const busy = converting();
    expect(reduce(busy, cancel(at(3), deadline))).toBe(busy);
  });

  it("provider received → deposit-seen provisional via rail; un-expires an expired record", () => {
    const seen = reduce(card(), meld(at(1), { status: "receiving" }));
    expect(seen.rail).toEqual({
      provider: "meld",
      status: "receiving",
      stage: "received",
      updatedAt: at(1),
    });
    expect(seen.status).toEqual({
      kind: "deposit-seen",
      at: at(1),
      assurance: "provisional",
      via: "rail",
    });
    expect(seen.funded).toBe(at(1));
    expect(seen.witnesses.provider).toEqual({ status: "receiving", at: at(1) });
    expect(seen.progress.latestRouteStatus).toBe("receiving");

    const deadline = submittedCardRecord.startedAt + DAY;
    expect(card().deadline).toEqual({ depositExpiresAt: deadline, source: "route" });
    // The buyer's paid stamp keeps a submitted card from expiring; an unsubmitted one does.
    const { meldSubmittedAt: _stamp, ...unsubmitted } = card();
    const expired = reduce(unsubmitted, clock(deadline + 1));
    expect(expired.status).toEqual({ kind: "expired", at: deadline + 1 });
    const revived = reduce(expired, meld(deadline + 2, { status: "receiving" }));
    expect(revived.status).toEqual({
      kind: "deposit-seen",
      at: deadline + 2,
      assurance: "provisional",
      via: "rail",
    });
    expect(revived.failureReason).toBeUndefined();
    expect(revived.failure).toBeUndefined();
    expect(revived.progress.failedAt).toBeUndefined();
  });

  it("provider failed at rank 0 → failed non-recoverable; at rank 2 → rail only", () => {
    const failed = reduce(card(), meld(at(1), declined));
    expect(failed.status).toEqual({ kind: "failed", at: at(1), recoverable: false });
    expect(failed.failure).toEqual({
      kind: "deposit-rejected",
      step: "deposit",
      message: DECLINED,
      recoverable: false,
    });
    expect(failed.failureReason).toBe(DECLINED);
    expect(failed.rail).toEqual({
      provider: "meld",
      status: "failed",
      stage: "failed",
      failure: { kind: "deposit-rejected", message: DECLINED, code: "declined" },
      updatedAt: at(1),
    });
    expect(failed.progress.failedAt).toBe(at(1));

    const busy = reduce(card(), workerSwap(at(1)));
    expect(busy.status).toEqual({ kind: "converting", at: at(2), step: "swap" });
    const railOnly = reduce(busy, meld(at(3), declined));
    expect(railOnly.status).toEqual(busy.status);
    expect(railOnly.failure).toBeUndefined();
    expect(railOnly.failureReason).toBeUndefined();
    expect(railOnly.rail.stage).toBe("failed");
    expect(railOnly.progress.failedAt).toBeUndefined();

    // A refund-like failure marks the record refunded, as core's own failure does. The record's
    // rail keeps its own provider.
    const refunded = reduce(awaiting(), {
      source: "provider",
      at: at(1),
      provider: "chainflip",
      result: returned,
    });
    expect(refunded.status).toEqual({ kind: "failed", at: at(1), recoverable: false });
    expect(refunded.refunded).toBe(true);
    expect(refunded.failure).toEqual({
      kind: "refunded",
      step: "deposit",
      message: RETURNED,
      recoverable: false,
      refunded: true,
    });
    expect(refunded.failureReason).toBe(RETURNED);
    expect(refunded.rail.provider).toBe("manual");
  });

  it("provider received then failed → failed non-recoverable; after a worker sighting the failure is rail only", () => {
    // Meld's sighting is the fiat leg moving; a decline can still follow it, and the record fails.
    const seen = reduce(card(), meld(at(1), { status: "receiving" }));
    expect(seen.status).toMatchObject({ kind: "deposit-seen", via: "rail" });
    const failed = reduce(seen, meld(at(2), declined));
    expect(failed.status).toEqual({ kind: "failed", at: at(2), recoverable: false });
    expect(failed.failure?.step).toBe("deposit");
    expect(failed.failure?.message).toBe(DECLINED);
    expect(failed.failureReason).toBe(DECLINED);
    expect(failed.rail.stage).toBe("failed");

    // The worker has the deposit in hand: the money leg is its to fail, the rail alone records
    // the provider's word.
    const onBurner = reduce(seen, worker(at(2), job({ fundsSeenAt: at(2), lastTickAt: at(2) })));
    expect(onBurner.status).toEqual({
      kind: "deposit-seen",
      at: at(1),
      assurance: "finalized",
      via: "rail",
    });
    const railOnly = reduce(onBurner, meld(at(3), declined));
    expect(railOnly.status).toEqual(onBurner.status);
    expect(railOnly.failure).toBeUndefined();
    expect(railOnly.failureReason).toBeUndefined();
    expect(railOnly.rail.stage).toBe("failed");
  });

  it("chain funds at best → deposit-seen provisional; worker fundsSeenAt upgrades to finalized", () => {
    const provisional = reduce(awaiting(), chain(at(1), FUNDS, "best", 8_000_100));
    expect(provisional.status).toEqual({
      kind: "deposit-seen",
      at: at(1),
      assurance: "provisional",
      via: "chain",
    });
    expect(provisional.funded).toBe(at(1));
    expect(provisional.witnesses.chain).toEqual({
      best: { burnerNative: FUNDS, block: 8_000_100, at: at(1) },
    });
    expect(provisional.confirmedAt).toBe(at(1));

    // The worker saw the funds half a minute before the probe; its tick has not moved on yet.
    const seenAt = at(1) - 30_000;
    const finalized = reduce(
      provisional,
      worker(at(2), job({ fundsSeenAt: seenAt, lastTickAt: at(2) })),
    );
    expect(finalized.status).toEqual({
      kind: "deposit-seen",
      at: at(1),
      assurance: "finalized",
      via: "chain",
    });
    expect(finalized.funded).toBe(seenAt);
  });

  it("chain funds on cancelled/expired/failed(rank 0) → deposit-seen (resurrection)", () => {
    const deadline = awaitingDepositCryptoRecord.depositExpiresAt!;
    const cases: [string, RequestRecord, number][] = [
      ["cancelled", migrated(cancelledCryptoRecord, requestRefOf("dot-assethub", 1)), at(5)],
      ["expired", reduce(awaiting(), clock(deadline + 1)), deadline + 5],
      ["failed", migrated(failedCryptoRecord, requestRefOf("dot-assethub", 2)), at(5)],
    ];
    for (const [name, start, time] of cases) {
      const revived = reduce(start, chain(time, FUNDS, "finalized"));
      expect(revived.status, name).toEqual({
        kind: "deposit-seen",
        at: time,
        assurance: "finalized",
        via: "chain",
      });
      expect(revived.cancelledAt, name).toBeUndefined();
      expect(revived.failureReason, name).toBeUndefined();
      expect(revived.failure, name).toBeUndefined();
      expect(revived.refunded, name).toBeUndefined();
      expect(revived.progress.failedAt, name).toBeUndefined();
      // The sighting completes the payment leg and no more; a record funded before its exit (the
      // failed fixture) keeps the leg it had already recorded.
      const { profile } = revived.progress;
      expect(revived.progress.routeCompletedAt, name).toBe(start.progress.routeCompletedAt ?? time);
      expect(revived.progress.confirmedStageKey, name).toBe(
        start.progress.confirmedStageKey ?? profile.stages[profile.routeStageCount - 1]!.key,
      );
    }
    // The failed fixture had already seen its deposit; the earliest sighting stands.
    const [, failedStart] = cases[2]!;
    expect(reduce(failedStart, chain(at(5), FUNDS, "finalized")).funded).toBe(
      failedCryptoRecord.funded,
    );
  });

  it("chain zero → status unchanged; witness recorded", () => {
    const busy = converting();
    const read = reduce(busy, chain(at(3), "0", "finalized"));
    expect(read.status).toEqual(busy.status);
    expect(read.funded).toBe(busy.funded);
    expect(read.witnesses.chain).toEqual({ finalized: { burnerNative: "0", at: at(3) } });
    expect(read.confirmedAt).toBe(at(3));

    const empty = reduce(awaiting(), chain(at(3), "0", "best"));
    expect(empty.status).toEqual({ kind: "awaiting-deposit" });
    expect(empty.funded).toBeUndefined();
  });

  it("chain zero after PROVISIONAL_REVERT_MS reverts a chain-provisional deposit-seen", () => {
    const provisional = reduce(awaiting(), chain(at(1), FUNDS, "best"));
    const within = reduce(provisional, chain(at(1) + PROVISIONAL_REVERT_MS, "0", "finalized"));
    expect(within.status).toEqual(provisional.status);

    // Only a finalized read can unwind the sighting.
    const bestZero = reduce(provisional, chain(at(1) + PROVISIONAL_REVERT_MS + 1, "0", "best"));
    expect(bestZero.status).toEqual(provisional.status);

    const reverted = reduce(
      provisional,
      chain(at(1) + PROVISIONAL_REVERT_MS + 1, "0", "finalized"),
    );
    expect(reverted.status).toEqual({ kind: "awaiting-deposit" });
    expect(reverted.witnesses.chain?.finalized).toEqual({
      burnerNative: "0",
      at: at(1) + PROVISIONAL_REVERT_MS + 1,
    });
  });

  it("worker phase lower than current rank → no change", () => {
    const arriving = reduce(
      awaiting(),
      worker(at(2), job({ phase: "await-arrival", fundsSeenAt: at(1), lastTickAt: at(2) })),
    );
    expect(arriving.status).toEqual({ kind: "converting", at: at(2), step: "await-arrival" });

    const stale = reduce(
      arriving,
      worker(at(3), job({ phase: "swap", fundsSeenAt: at(1), lastTickAt: at(3) })),
    );
    expect(stale.status).toEqual(arriving.status);
    // The swap and the teleport are one program, so awaiting the arrival is still the conversion.
    expect(stale.progress.confirmedStageKey).toBe("cash-conversion");
    expect(stale.witnesses.worker).toMatchObject({ known: true, phase: "swap", at: at(3) });

    const claiming = reduce(
      arriving,
      worker(at(4), job({ phase: "done", done: true, fundsSeenAt: at(1), lastTickAt: at(4) })),
    );
    expect(claiming.status).toEqual({ kind: "claiming", at: at(4) });
    const behind = reduce(
      claiming,
      worker(at(5), job({ phase: "swap", fundsSeenAt: at(1), lastTickAt: at(5) })),
    );
    expect(behind.status).toEqual(claiming.status);
  });

  it("stale observation (earlier at than the source witness) is dropped", () => {
    const record = reduce(awaiting(), worker(at(2), job({ lastTickAt: at(2) })));
    expect(record.witnesses.worker).toMatchObject({ known: true, at: at(2) });
    expect(reduce(record, workerSwap(at(0)))).toBe(record);

    // A chain read is checked against its own finality only.
    const best = reduce(record, chain(at(3), "0", "best"));
    const finalized = reduce(best, chain(at(2) + 30_000, "0", "finalized"));
    expect(finalized.witnesses.chain).toEqual({
      best: { burnerNative: "0", at: at(3) },
      finalized: { burnerNative: "0", at: at(2) + 30_000 },
    });
    expect(reduce(finalized, chain(at(2), "0", "best"))).toBe(finalized);
  });

  it("settled record: chain funds → conflict witness only", () => {
    const settled = migrated(settledCardRecord, requestRefOf("meld-card", 1));
    const read = reduce(settled, chain(at(1), FUNDS, "finalized"));
    expect(read.status).toEqual(settled.status);
    expect(read.funded).toBe(settledCardRecord.funded);
    expect(read.claimed).toBe(settledCardRecord.claimed);
    expect(read.progress).toBe(settled.progress);
    expect(read.witnesses.conflict).toEqual({
      source: "chain",
      note: "funds on a settled burner",
      at: at(1),
    });
    expect(read.witnesses.chain).toEqual({ finalized: { burnerNative: FUNDS, at: at(1) } });
    expect(read.confirmedAt).toBe(at(1));
    expect(read.updatedAt).toBe(at(1));
  });

  it("worker shortfall at converting → failed(recoverable); user retry → converting(swap)", () => {
    const shortfall = job({
      phase: "failed",
      failure: "shortfall",
      lastError: SHORTFALL,
      fundsSeenAt: at(1),
      lastTickAt: at(5),
    });
    const failed = reduce(converting(), worker(at(5), shortfall));
    expect(failed.status).toEqual({ kind: "failed", at: at(5), recoverable: true });
    expect(failed.failure).toEqual({
      kind: "mint",
      step: "swap",
      message: SHORTFALL,
      recoverable: true,
    });
    expect(failed.failureReason).toBe(SHORTFALL);
    expect(failed.progress.failedAt).toBe(at(5));

    const retried = reduce(failed, { source: "user", at: at(6), event: "retry" });
    expect(retried.status).toEqual({ kind: "converting", at: at(6), step: "swap" });
    expect(retried.failure).toBeUndefined();
    expect(retried.failureReason).toBeUndefined();
    expect(retried.progress.failedAt).toBeUndefined();
    expect(retried.progress.confirmedStageKey).toBe("cash-conversion");
  });

  it("worker held at converting → failed(recoverable) in the app's words; user retry → converting(swap)", () => {
    const held = job({
      phase: "failed",
      failure: "held",
      lastError: "funding held: the PSM refused the mint 3 times, last: Psm.MintingStopped",
      fundsSeenAt: at(1),
      lastTickAt: at(5),
    });
    const failed = reduce(converting(), worker(at(5), held));
    expect(failed.status).toEqual({ kind: "failed", at: at(5), recoverable: true });
    expect(failed.failure).toEqual({
      kind: "mint",
      step: "swap",
      message: FUNDING_HELD_REASON,
      recoverable: true,
    });
    expect(failed.failureReason).toBe(FUNDING_HELD_REASON);
    expect(failed.witnesses.worker).toMatchObject({ known: true, failure: "held" });

    const retried = reduce(failed, { source: "user", at: at(6), event: "retry" });
    expect(retried.status).toEqual({ kind: "converting", at: at(6), step: "swap" });
    expect(retried.failure).toBeUndefined();
    expect(retried.failureReason).toBeUndefined();
  });

  it("worker expired at rank 1 → ignored", () => {
    const seen = reduce(awaiting(), chain(at(1), FUNDS, "finalized"));
    expect(seen.status.kind).toBe("deposit-seen");
    const ignored = reduce(
      seen,
      worker(at(2), job({ phase: "failed", failure: "expired", lastTickAt: at(2) })),
    );
    expect(ignored.status).toEqual(seen.status);
    expect(ignored.failureReason).toBeUndefined();
    expect(ignored.failure).toBeUndefined();
    expect(ignored.progress.failedAt).toBeUndefined();
    expect(ignored.witnesses.worker).toMatchObject({
      known: true,
      phase: "failed",
      failure: "expired",
    });
  });

  it("worker claim failure → failed(recoverable) at the mint step; user retry → claiming", () => {
    const CLAIM_SHORT = "the host settled the claim short";
    const claiming = reduce(
      converting(),
      worker(at(3), job({ phase: "done", done: true, fundsSeenAt: at(1), lastTickAt: at(3) })),
    );
    expect(claiming.status).toEqual({ kind: "claiming", at: at(3) });

    const failed = reduce(
      claiming,
      worker(
        at(5),
        job({
          phase: "failed",
          failure: "claim",
          lastError: CLAIM_SHORT,
          done: true,
          fundsSeenAt: at(1),
          lastTickAt: at(5),
        }),
      ),
    );
    expect(failed.status).toEqual({ kind: "failed", at: at(5), recoverable: true });
    expect(failed.failure).toEqual({
      kind: "mint",
      step: "mint",
      message: CLAIM_SHORT,
      recoverable: true,
    });
    expect(failed.failureReason).toBe(CLAIM_SHORT);
    expect(failed.progress.failedAt).toBe(at(5));
    expect(failed.witnesses.worker).toMatchObject({
      known: true,
      phase: "failed",
      failure: "claim",
    });

    const retried = reduce(failed, { source: "user", at: at(6), event: "retry" });
    expect(retried.status).toEqual({ kind: "claiming", at: at(6) });
    expect(retried.failure).toBeUndefined();
    expect(retried.failureReason).toBeUndefined();
    expect(retried.progress.failedAt).toBeUndefined();
  });

  it("worker sizing and registering phases leave the record claiming and record the phase", () => {
    const registering = reduce(
      converting(),
      worker(
        at(3),
        job({
          phase: "done",
          done: true,
          fundsSeenAt: at(1),
          lastTickAt: at(3),
          claim: { phase: "registering", credited: "0", at: at(3) },
        }),
      ),
    );
    expect(registering.status).toEqual({ kind: "claiming", at: at(3) });
    expect(registering.claimed).toBeUndefined();
    expect(registering.settledAt).toBeUndefined();
    expect(registering.witnesses.worker).toMatchObject({
      known: true,
      claimPhase: "registering",
    });
    expect(registering.witnesses.worker).not.toHaveProperty("claimStatus");

    const claimed = reduce(
      registering,
      worker(
        at(4),
        job({
          phase: "done",
          done: true,
          fundsSeenAt: at(1),
          lastTickAt: at(4),
          claim: {
            phase: "claimed",
            amount: "20250000",
            credited: "20250000",
            at: at(4),
            status: "settled",
          },
        }),
      ),
    );
    expect(claimed.status).toEqual({ kind: "settled", at: at(4) });
    expect(claimed.settledAt).toBe(at(4));
    expect(claimed.claimed).toBe("20250000");
    expect(claimed.witnesses.worker).toMatchObject({
      known: true,
      claimPhase: "claimed",
      claimStatus: "settled",
    });
  });

  it("unchanged observation returns the same object reference", () => {
    const busy = converting();
    expect(reduce(busy, cancel(at(3)))).toBe(busy);
    expect(reduce(busy, { source: "user", at: at(3), event: "retry" })).toBe(busy);

    const submitted = card();
    expect(submitted.meldSubmittedAt).toBe(submittedCardRecord.meldSubmittedAt);
    expect(reduce(submitted, { source: "user", at: at(1), event: "meld-submitted" })).toBe(
      submitted,
    );
  });

  it("a deposit-skipped user event stamps depositSkippedAt once, then is idempotent", () => {
    const record = awaiting();
    expect(record.depositSkippedAt).toBeUndefined();
    const skipped = reduce(record, { source: "user", at: at(1), event: "deposit-skipped" });
    expect(skipped.depositSkippedAt).toBe(at(1));
    // A second press keeps the first stamp and returns the same reference.
    expect(reduce(skipped, { source: "user", at: at(2), event: "deposit-skipped" })).toBe(skipped);
  });
});
