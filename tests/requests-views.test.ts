// The views are the one table every screen reads a record through: the list row's state, and the
// values the session store exposed before them.

import { describe, expect, it } from "vitest";
import { projectChainflipTopUps } from "../app/funding/chainflip-top-ups";
import { fundingSelectorConfig } from "../app/funding/config";
import { migrateRecord } from "../app/funding/requests/migrate";
import {
  PAYMENT_WATCH_MS,
  paymentWatchUntil,
  TOMBSTONE_GRACE_MS,
  type Observation,
  type RailState,
  type RequestFailure,
  type RequestRecord,
  type RequestStatus,
} from "../app/funding/requests/model";
import { reduce } from "../app/funding/requests/reducer";
import {
  claimingOf,
  creditedAmountOf,
  meldHandedOffOf,
  meldStageOf,
  phaseLike,
  rowStateOf,
} from "../app/funding/requests/views";
import { projectFundingTopUps } from "../app/funding/top-ups";
import { requestRefOf } from "../app/utils/request-index";
import { awaitingDepositCryptoRecord, FIXTURE_NOW, submittedCardRecord } from "./fixtures/requests";

const AT = FIXTURE_NOW + 60_000;

function migrated(record: typeof awaitingDepositCryptoRecord, sourceId: string, tradeN: number) {
  const result = migrateRecord(record, requestRefOf(sourceId, tradeN), FIXTURE_NOW);
  if (result === null) throw new Error("fixture did not migrate");
  return result;
}
const crypto = () => migrated(awaitingDepositCryptoRecord, "dot-assethub", 3);
const card = () => migrated(submittedCardRecord, "meld-card", 2);

type Extra = Partial<Pick<RequestRecord, "failure" | "failureReason" | "refunded" | "rail">>;
/** The crypto record at a status, with the record fields that status implies. */
const at = (status: RequestStatus, extra: Extra = {}): RequestRecord => ({
  ...crypto(),
  status,
  ...extra,
});
const rail = (
  provider: RailState["provider"],
  stage: RailState["stage"],
  status: RailState["status"],
): RailState => ({ provider, status, stage, updatedAt: AT });

const mintFailure: RequestFailure = {
  kind: "mint",
  step: "mint",
  message: "claim failed",
  recoverable: true,
};
const shortfall: RequestFailure = {
  kind: "mint",
  step: "swap",
  message: "shortfall: the deposit is below the swap minimum",
  recoverable: true,
};

describe("request views", () => {
  it("paymentWatchUntil measures from the start, and a rail expiry only extends it", () => {
    const started = FIXTURE_NOW;
    const watch = started + PAYMENT_WATCH_MS + TOMBSTONE_GRACE_MS;
    // No rail expiry, or one inside the watch: the watch stands. A pay page that closed early
    // says nothing about a transfer already sent.
    expect(
      paymentWatchUntil({
        startedAt: started,
        deadline: { depositExpiresAt: null, source: "route" },
      }),
    ).toBe(watch);
    expect(
      paymentWatchUntil({
        startedAt: started,
        deadline: { depositExpiresAt: started + 3_600_000, source: "rail" },
      }),
    ).toBe(watch);
    // A rail expiry beyond it extends the watch rather than being ignored.
    const late = started + 10 * 24 * 3_600_000;
    expect(
      paymentWatchUntil({
        startedAt: started,
        deadline: { depositExpiresAt: late, source: "rail" },
      }),
    ).toBe(late + TOMBSTONE_GRACE_MS);
  });

  it("rowStateOf words a running row with its label and an ended one from the record", () => {
    const chainFunds: Observation = {
      source: "chain",
      at: AT,
      burnerNative: "250000000000",
      finality: "finalized",
      via: "probe",
    };
    const workerSwap: Observation = {
      source: "worker",
      at: AT + 30_000,
      job: { phase: "swap", done: false, fundsSeenAt: AT, lastTickAt: AT + 30_000, claim: null },
    };

    const funded = reduce(crypto(), chainFunds);
    expect(funded.status.kind).toBe("deposit-seen");
    expect(rowStateOf(funded, "On its way")).toEqual({ kind: "finishing", status: "On its way" });

    const converting = reduce(funded, workerSwap);
    expect(converting.status.kind).toBe("converting");
    expect(rowStateOf(converting, "Adding to your balance")).toEqual({
      kind: "finishing",
      status: "Adding to your balance",
    });

    const settled: RequestRecord = {
      ...crypto(),
      status: { kind: "settled", at: AT },
      settledAt: AT,
      claimed: "25250000",
    };
    expect(rowStateOf(settled, "")).toEqual({
      kind: "settled",
      at: AT,
      creditedAmount: "25.25",
    });

    const failed = at({ kind: "failed", at: AT, recoverable: true }, { failure: shortfall });
    expect(rowStateOf(failed, "")).toEqual({
      kind: "failed",
      at: AT,
      reason: shortfall.message,
    });
  });

  it("a claiming record the host reported in a block reads as settled; a failed one ignores the stamp", () => {
    const CREDITED_AT = AT + 3_000;
    const now = AT + 60_000;
    const claiming = at({ kind: "claiming", at: AT });
    const credited: RequestRecord = { ...claiming, creditedAt: CREDITED_AT, claimed: "25250000" };
    const settled: RequestRecord = {
      ...crypto(),
      status: { kind: "settled", at: CREDITED_AT },
      settledAt: CREDITED_AT,
      claimed: "25250000",
    };

    // Until the host's word the claim is in flight.
    expect(rowStateOf(claiming, "").kind).toBe("finishing");
    expect(phaseLike(claiming)).toBe("working");
    expect(claimingOf(claiming)).toBe(true);

    // From it, every view reads as the settled record's: the row and its section, the phase and
    // the claim spinner.
    const row = rowStateOf(credited, "");
    expect(row).toEqual({ kind: "settled", at: CREDITED_AT, creditedAmount: "25.25" });
    expect(row).toEqual(rowStateOf(settled, ""));
    expect(phaseLike(credited)).toBe("done");
    expect(claimingOf(credited)).toBe(false);
    const sections = projectFundingTopUps(
      projectChainflipTopUps([credited], now),
      fundingSelectorConfig,
    );
    expect(sections.inProgress).toEqual([]);
    expect(sections.past[0]?.state).toEqual({
      kind: "settled",
      status: "Added",
      at: CREDITED_AT,
      creditedAmount: "25.25",
    });

    // A record that failed after the host's word shows the failure, the stamp notwithstanding.
    const failedAt = AT + 9_000;
    const failed: RequestRecord = {
      ...credited,
      status: { kind: "failed", at: failedAt, recoverable: true },
      failure: mintFailure,
      failureReason: mintFailure.message,
    };
    expect(rowStateOf(failed, "")).toEqual({
      kind: "failed",
      at: failedAt,
      reason: mintFailure.message,
    });
    expect(phaseLike(failed)).toBe("failed");
    expect(claimingOf(failed)).toBe(false);
  });

  it("meldStageOf and meldHandedOffOf reproduce today's values", () => {
    // The Meld stage: the buyer's own paid stamp shows the journey, the provider's first sighting
    // alone does not; settled and failed are the provider's.
    const stamped = card();
    expect(stamped.meldSubmittedAt).toBeDefined();
    const { meldSubmittedAt: _stamp, ...unstamped } = stamped;
    const meld = (
      record: RequestRecord,
      stage: RailState["stage"],
      status: RailState["status"],
    ) => ({
      ...record,
      rail: rail("meld", stage, status),
    });
    expect(meldStageOf(crypto())).toBeNull();
    expect(meldHandedOffOf(crypto())).toBe(false);

    expect(meldStageOf(meld(unstamped, "waiting", "waiting"))).toBe("waiting");
    expect(meldHandedOffOf(meld(unstamped, "waiting", "waiting"))).toBe(false);
    expect(meldStageOf(meld(stamped, "waiting", "waiting"))).toBe("receiving");
    expect(meldHandedOffOf(meld(stamped, "waiting", "waiting"))).toBe(true);

    expect(meldStageOf(meld(unstamped, "received", "receiving"))).toBe("waiting");
    expect(meldHandedOffOf(meld(unstamped, "received", "receiving"))).toBe(false);
    expect(meldStageOf(meld(stamped, "received", "receiving"))).toBe("receiving");
    expect(meldHandedOffOf(meld(stamped, "received", "receiving"))).toBe(true);

    expect(meldStageOf(meld(unstamped, "delivered", "complete"))).toBe("complete");
    expect(meldHandedOffOf(meld(unstamped, "delivered", "complete"))).toBe(true);
    expect(meldStageOf(meld(stamped, "delivered", "complete"))).toBe("complete");

    expect(meldStageOf(meld(unstamped, "failed", "failed"))).toBe("failed");
    expect(meldHandedOffOf(meld(unstamped, "failed", "failed"))).toBe(false);
  });

  it("creditedAmountOf reads what the Host credited only once the top-up ended", () => {
    const minted = (claimCredited: string): Pick<RequestRecord, "witnesses"> => ({
      witnesses: {
        worker: {
          known: true,
          phase: "failed",
          done: false,
          fundsSeenAt: AT,
          lastTickAt: AT,
          at: AT,
          claimCredited,
        },
      },
    });
    const failed = { kind: "failed", at: AT, recoverable: true } as const;
    const partial = { ...at(failed, { failure: mintFailure }), ...minted("30000000") };
    const cases: [string, RequestRecord, string | undefined][] = [
      ["claim in flight", { ...at({ kind: "claiming", at: AT }), claimed: "80120000" }, undefined],
      [
        "claim in a block",
        { ...at({ kind: "claiming", at: AT }), claimed: "80120000", creditedAt: AT },
        "80.12",
      ],
      ["settled", { ...at({ kind: "settled", at: AT }), claimed: "80120000" }, "80.12"],
      ["settled with no claim", at({ kind: "settled", at: AT }), undefined],
      ["partial claim", partial, "30"],
      [
        "failed with nothing minted",
        { ...at(failed), ...minted("0"), claimed: "80120000" },
        undefined,
      ],
    ];
    for (const [name, record, credited] of cases) {
      expect(creditedAmountOf(record), name).toBe(credited);
    }

    // A journey opened from history reads it off the list row.
    expect(rowStateOf(partial, "")).toMatchObject({ kind: "failed", creditedAmount: "30" });
  });
});
