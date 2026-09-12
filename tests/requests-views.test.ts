// The views reproduce the session store's inputs: what `journeyDone` and the adapters read today.

import { describe, expect, it } from "vitest";
import { migrateRecord } from "../app/funding/requests/migrate";
import {
  DEPOSIT_EXPIRED_REASON,
  type RailState,
  type RequestFailure,
  type RequestRecord,
  type RequestStatus,
} from "../app/funding/requests/model";
import {
  journeyInput,
  legacyRequestStatus,
  meldHandedOffOf,
  meldStageOf,
} from "../app/funding/requests/views";
import { journeyDone, type JourneyInput } from "../app/utils/journey";
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
const seen = (via: Extract<RequestStatus, { kind: "deposit-seen" }>["via"]): RequestStatus => ({
  kind: "deposit-seen",
  at: AT,
  assurance: "provisional",
  via,
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
  it("journeyInput matches today's inputs for each status", () => {
    const idle = { fundingStep: null, swap: null, failure: null } as const;
    const cases: [string, RequestRecord, JourneyInput, number][] = [
      [
        "awaiting-deposit",
        at({ kind: "awaiting-deposit" }),
        { phase: "awaiting-deposit", ...idle },
        1,
      ],
      // The worker's job and the faucet set today's step; other sightings set none.
      [
        "deposit-seen via worker",
        at(seen("worker")),
        { phase: "awaiting-deposit", ...idle, fundingStep: "swap" },
        3,
      ],
      [
        "deposit-seen via faucet",
        at(seen("faucet")),
        { phase: "awaiting-deposit", ...idle, fundingStep: "swap" },
        3,
      ],
      ["deposit-seen via chain", at(seen("chain")), { phase: "awaiting-deposit", ...idle }, 1],
      [
        "deposit-seen via core on the manual rail",
        at(seen("core")),
        { phase: "awaiting-deposit", ...idle },
        1,
      ],
      // A rail's own sighting is core's swapping phase, with the rail's status as the swap.
      [
        "Chainflip receiving",
        at(seen("core"), { rail: rail("chainflip", "received", "receiving") }),
        { phase: "swapping", ...idle, swap: "receiving" },
        1,
      ],
      [
        "Chainflip swapping",
        at(seen("rail"), { rail: rail("chainflip", "processing", "swapping") }),
        { phase: "swapping", ...idle, swap: "swapping" },
        2,
      ],
      [
        "Chainflip complete",
        at(seen("rail"), { rail: rail("chainflip", "delivered", "complete") }),
        { phase: "swapping", ...idle, swap: "complete" },
        3,
      ],
      [
        "Meld receiving",
        { ...card(), status: seen("rail"), rail: rail("meld", "received", "receiving") },
        { phase: "swapping", ...idle, swap: "receiving" },
        1,
      ],
      [
        "converting swap",
        at({ kind: "converting", at: AT, step: "swap" }),
        { phase: "awaiting-deposit", ...idle, fundingStep: "swap" },
        3,
      ],
      [
        "converting await-arrival",
        at({ kind: "converting", at: AT, step: "await-arrival" }),
        { phase: "awaiting-deposit", ...idle, fundingStep: "await-arrival" },
        3,
      ],
      [
        "claiming",
        at({ kind: "claiming", at: AT }),
        { phase: "working", ...idle, fundingStep: "done" },
        4,
      ],
      [
        "settled",
        at({ kind: "settled", at: AT }),
        { phase: "done", ...idle, fundingStep: "done" },
        5,
      ],
      // A side exit reports the leg it kept the rank of.
      [
        "failed at the claim",
        at({ kind: "failed", at: AT, recoverable: true }, { failure: mintFailure }),
        { phase: "failed", ...idle, fundingStep: "done", failure: { kind: "mint" } },
        4,
      ],
      [
        "failed at the swap",
        at({ kind: "failed", at: AT, recoverable: true }, { failure: shortfall }),
        { phase: "failed", ...idle, fundingStep: "swap", failure: { kind: "mint" } },
        3,
      ],
      [
        "failed at the deposit",
        at({ kind: "failed", at: AT, recoverable: false }, { failure: rejected }),
        { phase: "failed", ...idle, failure: { kind: "deposit-rejected" } },
        1,
      ],
      [
        "failed and refunded",
        at({ kind: "failed", at: AT, recoverable: false }, { failure: refunded, refunded: true }),
        { phase: "failed", ...idle, failure: { kind: "refunded" } },
        2,
      ],
      [
        "expired",
        at({ kind: "expired", at: AT }, { failureReason: DEPOSIT_EXPIRED_REASON }),
        { phase: "failed", ...idle },
        1,
      ],
      ["cancelled", at({ kind: "cancelled", at: AT }), { phase: "idle", ...idle }, 1],
    ];
    for (const [name, record, storeInput, done] of cases) {
      expect(journeyInput(record), name).toEqual(storeInput);
      expect(journeyDone(storeInput), name).toBe(done);
      expect(journeyDone(journeyInput(record)), name).toBe(done);
    }
  });

  it("legacyRequestStatus and meldStageOf reproduce today's values", () => {
    expect(legacyRequestStatus(at({ kind: "awaiting-deposit" }))).toBeUndefined();
    expect(legacyRequestStatus(at(seen("worker")))).toBeUndefined();
    expect(legacyRequestStatus(at({ kind: "converting", at: AT, step: "xcm" }))).toEqual({
      kind: "converting",
      step: "xcm",
    });
    expect(legacyRequestStatus(at({ kind: "claiming", at: AT }))).toEqual({
      kind: "converting",
      step: "done",
    });
    expect(legacyRequestStatus(at({ kind: "settled", at: AT }))).toBeUndefined();
    expect(
      legacyRequestStatus(
        at({ kind: "failed", at: AT, recoverable: true }, { failure: mintFailure }),
      ),
    ).toEqual({ kind: "failed", reason: "claim failed" });
    expect(
      legacyRequestStatus(
        at({ kind: "failed", at: AT, recoverable: false }, { failure: refunded, refunded: true }),
      ),
    ).toEqual({ kind: "failed", reason: "returned", refunded: true });
    expect(
      legacyRequestStatus(
        at({ kind: "failed", at: AT, recoverable: false }, { failureReason: "persisted reason" }),
      ),
    ).toEqual({ kind: "failed", reason: "persisted reason" });
    expect(legacyRequestStatus(at({ kind: "expired", at: AT }))).toEqual({
      kind: "failed",
      reason: DEPOSIT_EXPIRED_REASON,
    });
    expect(legacyRequestStatus(at({ kind: "cancelled", at: AT }))).toBeUndefined();

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
