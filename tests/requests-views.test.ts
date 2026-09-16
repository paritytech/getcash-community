// The views are the one table every screen reads a record through: the journey's step count,
// the list row's state, and the values the session store exposed before them.

import { describe, expect, it } from "vitest";
import { projectFundingProgress } from "../app/funding/progress";
import { migrateRecord } from "../app/funding/requests/migrate";
import {
  DEPOSIT_EXPIRED_REASON,
  type Observation,
  type RailState,
  type RequestFailure,
  type RequestRecord,
  type RequestStatus,
} from "../app/funding/requests/model";
import { reduce } from "../app/funding/requests/reducer";
import {
  journeyStepsOf,
  meldHandedOffOf,
  meldStageOf,
  rowStateOf,
} from "../app/funding/requests/views";
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
type DepositSeen = Extract<RequestStatus, { kind: "deposit-seen" }>;
const seen = (
  via: DepositSeen["via"],
  assurance: DepositSeen["assurance"] = "provisional",
): RequestStatus => ({ kind: "deposit-seen", at: AT, assurance, via });
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
const rejected: RequestFailure = {
  kind: "deposit-rejected",
  step: "deposit",
  message: "Below minimum",
  recoverable: false,
};
/** A Chainflip refund as the reducer stores it: core names the swap leg, the record the deposit
 *  it left from. */
const refunded: RequestFailure = {
  kind: "refunded",
  step: "deposit",
  message: "returned",
  recoverable: false,
  refunded: true,
};

describe("request views", () => {
  // The scale is the caller's, not the record's, so both tables read the same builders; only the
  // card table's first case needs a record of its own rail.
  it("journeyStepsOf counts the crypto journey's three stops from the record", () => {
    const cases: [string, RequestRecord, number][] = [
      // The journey opens on the first sighting: before that the deposit screen is showing, so
      // nothing is complete.
      ["awaiting-deposit", at({ kind: "awaiting-deposit" }), 0],
      ["expired", at({ kind: "expired", at: AT }, { failureReason: DEPOSIT_EXPIRED_REASON }), 0],
      ["cancelled", at({ kind: "cancelled", at: AT }), 0],
      // "Started" is the deposit seen at a best block, whatever confirmed it.
      ["deposit-seen provisional via chain", at(seen("chain")), 1],
      ["deposit-seen finalized via worker", at(seen("worker", "finalized")), 1],
      // One program swaps and teleports, so both steps sit inside "Conversion".
      ["converting at the swap", at({ kind: "converting", at: AT, step: "swap" }), 1],
      [
        "converting, awaiting arrival",
        at({ kind: "converting", at: AT, step: "await-arrival" }),
        1,
      ],
      // The worker reported `done`: the conversion is behind the record and the claim has started.
      ["claiming", at({ kind: "claiming", at: AT }), 2],
      ["settled", at({ kind: "settled", at: AT }), 3],
      [
        "failed at the claim",
        at({ kind: "failed", at: AT, recoverable: true }, { failure: mintFailure }),
        2,
      ],
      [
        "failed at the swap",
        at({ kind: "failed", at: AT, recoverable: true }, { failure: shortfall }),
        1,
      ],
      // The network took the deposit, so it was seen; a plain rejection means it never was.
      [
        "failed at the deposit, refunded",
        at({ kind: "failed", at: AT, recoverable: false }, { failure: refunded, refunded: true }),
        1,
      ],
      [
        "failed at the deposit, rejected",
        at({ kind: "failed", at: AT, recoverable: false }, { failure: rejected }),
        0,
      ],
    ];
    for (const [name, record, steps] of cases) {
      expect(journeyStepsOf(record, 3), name).toBe(steps);
    }
  });

  it("journeyStepsOf counts the card and bank journey's five stops from the record", () => {
    const cases: [string, RequestRecord, number][] = [
      // "Started" is the request itself: it exists, so the first marker is behind it.
      ["awaiting-deposit", at({ kind: "awaiting-deposit" }), 1],
      // A provisional sighting by any witness is a payment received; "Approved" waits for the
      // deposit on the burner at finality, whatever the rail reports of its delivery.
      [
        "deposit-seen provisional via rail",
        { ...card(), status: seen("rail"), rail: rail("meld", "received", "receiving") },
        2,
      ],
      ["deposit-seen provisional via chain", at(seen("chain")), 2],
      ["deposit-seen finalized via worker", at(seen("worker", "finalized")), 3],
      ["deposit-seen finalized via faucet", at(seen("faucet", "finalized")), 3],
      [
        "deposit-seen provisional via rail, rail delivered",
        at(seen("rail"), { rail: rail("chainflip", "delivered", "complete") }),
        2,
      ],
      // One program swaps and teleports, so both steps sit inside "Conversion".
      ["converting at the swap", at({ kind: "converting", at: AT, step: "swap" }), 3],
      [
        "converting, awaiting arrival",
        at({ kind: "converting", at: AT, step: "await-arrival" }),
        3,
      ],
      // The worker reported `done`: the conversion is behind the record and the claim has started.
      ["claiming", at({ kind: "claiming", at: AT }), 4],
      ["settled", at({ kind: "settled", at: AT }), 5],
      // A side exit reports the leg it left; from the deposit, the kind says whether the network
      // took the payment.
      [
        "failed at the claim",
        at({ kind: "failed", at: AT, recoverable: true }, { failure: mintFailure }),
        4,
      ],
      [
        "failed at the swap",
        at({ kind: "failed", at: AT, recoverable: true }, { failure: shortfall }),
        3,
      ],
      [
        "failed at the deposit, refunded",
        at({ kind: "failed", at: AT, recoverable: false }, { failure: refunded, refunded: true }),
        2,
      ],
      [
        "failed at the deposit, rejected",
        at({ kind: "failed", at: AT, recoverable: false }, { failure: rejected }),
        1,
      ],
      ["expired", at({ kind: "expired", at: AT }, { failureReason: DEPOSIT_EXPIRED_REASON }), 1],
      ["cancelled", at({ kind: "cancelled", at: AT }), 1],
    ];
    for (const [name, record, steps] of cases) {
      expect(journeyStepsOf(record, 5), name).toBe(steps);
    }
  });

  it("rowStateOf uses the same words as the journey", () => {
    const now = AT + 60_000;
    const projection = (record: RequestRecord) =>
      projectFundingProgress({ snapshot: record.progress, createdAt: record.startedAt, now });
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

    // The chain saw the deposit: the payment leg is complete on the row and in the ribbon alike.
    const funded = reduce(crypto(), chainFunds);
    expect(funded.status.kind).toBe("deposit-seen");
    const fundedProjection = projection(funded);
    const { profile } = funded.progress;
    expect(fundedProjection.view.label).toBe(profile.routeCompletedLabel);
    expect(fundedProjection.view.label).toBe("Payment received");
    expect(rowStateOf(funded, fundedProjection)).toEqual({
      kind: "finishing",
      status: profile.routeCompletedLabel,
    });

    // The worker reports the swap: both now say the conversion is running.
    const converting = reduce(funded, workerSwap);
    expect(converting.status.kind).toBe("converting");
    const convertingProjection = projection(converting);
    const conversion = profile.stages.find((stage) => stage.key === "cash-conversion")!;
    expect(convertingProjection.view.label).toBe(conversion.activeLabel);
    expect(convertingProjection.view.label).toBe("Converting to $CASH");
    expect(rowStateOf(converting, convertingProjection)).toEqual({
      kind: "finishing",
      status: conversion.activeLabel,
    });

    const settled: RequestRecord = {
      ...crypto(),
      status: { kind: "settled", at: AT },
      settledAt: AT,
      claimed: "25250000",
    };
    expect(rowStateOf(settled, projection(settled))).toEqual({
      kind: "settled",
      at: AT,
      creditedAmount: "25.25",
    });

    const failed = at({ kind: "failed", at: AT, recoverable: true }, { failure: shortfall });
    expect(rowStateOf(failed, projection(failed))).toEqual({
      kind: "failed",
      at: AT,
      reason: shortfall.message,
    });
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
});
