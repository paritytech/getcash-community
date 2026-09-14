import { describe, expect, it } from "vitest";
import {
  MELD_WINDOW_CLOSED_REASON,
  meldRequestRef,
  projectMeldTopUps,
} from "../app/funding/meld-top-ups";
import { createFundingProgressSnapshot, meldProgressProvider } from "../app/funding/progress";
import { migrateRecord } from "../app/funding/requests/migrate";
import type { Observation, RequestRecord } from "../app/funding/requests/model";
import { reduce } from "../app/funding/requests/reducer";
import type { ActiveFlowRecord } from "../app/stores/session";
import { requestRefOf } from "../app/utils/request-index";

type Stored = Partial<ActiveFlowRecord> & {
  tradeN: number;
  amountHuman: string;
  startedAt: number;
};

/** A stored record as the store reads it: migrated under its own key at `now`. */
function record(stored: Stored, now: number): RequestRecord {
  const migrated = migrateRecord(stored, requestRefOf(stored.sourceId, stored.tradeN), now);
  if (migrated === null) throw new Error("record did not migrate");
  return migrated;
}

/** The worker's job at `phase`, its deposit in hand since `at`. */
const worker = (at: number, phase: string): Observation => ({
  source: "worker",
  at,
  job: { phase, done: phase === "done", fundsSeenAt: at, lastTickAt: at, claim: null },
});

describe("Meld top-up adapter", () => {
  it("projects card and bank records under their routes, with the fiat the buyer paid", () => {
    const now = 1_000;
    const records = [
      record(
        {
          tradeN: 3,
          amountHuman: "100",
          startedAt: 300,
          sourceId: "meld-card",
          sourceAmount: "104.12",
          sourceSymbol: "EUR",
          meldCountry: "DE",
        },
        now,
      ),
      record(
        { tradeN: 1, amountHuman: "50", startedAt: 100, sourceId: "meld-bank", funded: 150 },
        now,
      ),
    ];
    const topUps = projectMeldTopUps(records, now);

    expect(topUps[0]).toMatchObject({
      id: "card:meld-card#3",
      route: "card",
      amount: "100",
      details: {
        provider: { label: "Meld", icon: "/icons/card.svg" },
        method: { label: "Card", icon: "/icons/card.svg" },
        region: "DE",
      },
      progress: { view: { kind: "waiting", label: "Waiting for your payment" } },
      state: { kind: "awaiting-transfer", status: "Waiting for your payment" },
    });
    expect(topUps[0]?.details).not.toHaveProperty("network");
    expect(topUps[0]?.details).not.toHaveProperty("token");
    expect(topUps[1]).toMatchObject({
      id: "bank:meld-bank#1",
      route: "bank",
      details: { method: { label: "Bank transfer" } },
      state: { kind: "finishing", status: "Converting to $CASH" },
    });
  });

  it("shows the conversion running once the worker reports the swap", () => {
    const snapshot = createFundingProgressSnapshot(meldProgressProvider.createProfile());
    const waiting = record(
      { tradeN: 4, amountHuman: "20", startedAt: 400, sourceId: "meld-card", progress: snapshot },
      500,
    );
    const converting = reduce(waiting, worker(450, "swap"));
    expect(projectMeldTopUps([converting], 500)[0]?.state).toEqual({
      kind: "finishing",
      status: "Converting to $CASH",
    });
  });

  it("projects failed and settled requests as history, with the reason the record kept", () => {
    const now = 900;
    const records = [
      record(
        {
          tradeN: 5,
          amountHuman: "40",
          startedAt: 500,
          sourceId: "meld-card",
          failureReason: "Top-up didn't go through. No money was taken.",
          progress: createFundingProgressSnapshot(meldProgressProvider.createProfile(), {
            failedAt: 700,
          }),
        },
        now,
      ),
      record(
        {
          tradeN: 6,
          amountHuman: "100",
          startedAt: 600,
          sourceId: "meld-bank",
          settledAt: 800,
          claimed: "100250000",
        },
        now,
      ),
    ];
    expect(projectMeldTopUps(records, now).map(({ state }) => state)).toEqual([
      { kind: "failed", at: 700, reason: "Top-up didn't go through. No money was taken." },
      { kind: "settled", at: 800, creditedAmount: "100.25" },
    ]);
  });

  it("says a lapsed window in fiat terms", () => {
    const waiting = record(
      { tradeN: 7, amountHuman: "40", startedAt: 500, sourceId: "meld-card" },
      900,
    );
    const expired = reduce(waiting, {
      source: "clock",
      at: waiting.deadline.depositExpiresAt! + 1,
    });
    expect(projectMeldTopUps([expired], 900)[0]?.state).toMatchObject({
      kind: "failed",
      reason: MELD_WINDOW_CLOSED_REASON,
    });
  });

  it("leaves other rails' records alone and reads only its own ids", () => {
    const records = [
      record({ tradeN: 7, amountHuman: "25", startedAt: 100, sourceId: "dot-assethub" }, 200),
      record({ tradeN: 7, amountHuman: "25", startedAt: 100 }, 200), // pre-source-aware: crypto
      record({ tradeN: 7, amountHuman: "30", startedAt: 110, sourceId: "meld-card" }, 200),
    ];
    expect(projectMeldTopUps(records).map(({ id }) => id)).toEqual(["card:meld-card#7"]);
    expect(meldRequestRef("bank:meld-bank#1")).toEqual({ sourceId: "meld-bank", tradeN: 1 });
    expect(meldRequestRef("card:meld-card#12")).toEqual({ sourceId: "meld-card", tradeN: 12 });
    expect(meldRequestRef("card:meld-bank#1")).toBeNull(); // route/source mismatch
    expect(meldRequestRef("crypto:dot-assethub#1")).toBeNull();
    expect(meldRequestRef("card:#1")).toBeNull(); // a fiat request always has a source
  });
});
