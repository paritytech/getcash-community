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

  it("carries the reference and the provider a failed journey has to show", () => {
    // Both are read off the record, not off a live session: the journey that needs them is
    // re-opened from the list after a restart, with nothing live left to ask.
    const now = 900;
    const failed = record(
      {
        tradeN: 7,
        amountHuman: "50",
        startedAt: 500,
        sourceId: "meld-card",
        sourceAmount: "52.06",
        sourceSymbol: "USD",
        sourceFee: "1.56",
        sourceProvider: "TRANSAK",
        meldFundingRequestId: "a1f9c3d2-7b44-4e10-9f21-00ab9e4c2e",
      },
      now,
    );

    expect(projectMeldTopUps([failed], now)[0]).toMatchObject({
      reference: "a1f9c3d2-7b44-4e10-9f21-00ab9e4c2e",
      quote: { amount: "52.06", symbol: "USD", fee: "1.56", provider: "TRANSAK" },
      // Named off the quote's provider: this record kept no `meldServiceProvider`, and the
      // aggregator's name would have told the buyer less than the one it kept.
      details: { provider: { label: "Transak" } },
    });
  });

  it("draws the provider Meld named, not Meld's shouting of it", () => {
    // Meld sends "TRANSAK"; the design draws "Transak". The record keeps Meld's own spelling, so
    // it still matches what support sees, and the row re-cases it on the way to the screen.
    const now = 900;
    const paid = (provider: string, tradeN: number) =>
      record(
        {
          tradeN,
          amountHuman: "50",
          startedAt: 500,
          sourceId: "meld-card",
          meldServiceProvider: provider,
        },
        now,
      );

    const labelOf = (provider: string, tradeN = 11) =>
      projectMeldTopUps([paid(provider, tradeN)], now)[0]?.details?.provider?.label;

    expect(labelOf("TRANSAK")).toBe("Transak");
    expect(labelOf("COINBASE_PAY")).toBe("Coinbase Pay");
    // A name that already carries its own casing is left alone rather than overruled.
    expect(labelOf("MoonPay")).toBe("MoonPay");
  });

  it("prefers who took the payment over who priced it", () => {
    // The two can only disagree if Meld moved the request to another provider after quoting it.
    // The create call is the one that names who was actually paid.
    const now = 900;
    const moved = record(
      {
        tradeN: 12,
        amountHuman: "50",
        startedAt: 500,
        sourceId: "meld-card",
        sourceProvider: "KOYWE",
        meldServiceProvider: "TRANSAK",
      },
      now,
    );
    expect(projectMeldTopUps([moved], now)[0]?.details?.provider?.label).toBe("Transak");
  });

  it("leaves both out of a record that never carried them", () => {
    const now = 900;
    const bare = record(
      { tradeN: 8, amountHuman: "50", startedAt: 500, sourceId: "meld-card" },
      now,
    );
    const topUp = projectMeldTopUps([bare], now)[0];

    expect(topUp).not.toHaveProperty("reference");
    expect(topUp?.quote).toBeUndefined();
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

  it("counts the journey's markers on the row, for a journey opened with nothing live", () => {
    // The journey reads the count off the request on screen; opened from history there is none,
    // and the row is the only thing that can say how far this top-up actually got. A card top-up
    // whose payment landed and whose claim then failed stands on four of five markers.
    const paid = reduce(
      record({ tradeN: 9, amountHuman: "50", startedAt: 100, sourceId: "meld-card" }, 200),
      worker(300, "done"),
    );
    const mintFailed = reduce(paid, {
      source: "core",
      at: 400,
      state: {
        phase: "failed",
        sourceId: "meld-card",
        failure: {
          kind: "mint",
          step: "mint",
          message: "Settled, but verification failed.",
          recoverable: true,
        },
      } as never,
    });
    expect(projectMeldTopUps([mintFailed], 500)[0]?.journeyDone).toBe(4);
    // Nothing paid yet: the card scale's first marker alone.
    const waiting = record(
      { tradeN: 10, amountHuman: "50", startedAt: 100, sourceId: "meld-card" },
      200,
    );
    expect(projectMeldTopUps([waiting], 500)[0]?.journeyDone).toBe(1);
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
