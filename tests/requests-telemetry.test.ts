// A request's journey and failures as the store's commits drive them (app/funding/requests/
// telemetry.ts), against a recording stand-in for the telemetry doorway.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { migrateRecord } from "../app/funding/requests/migrate";
import type {
  RequestRecord,
  RequestStatus,
  TopUpRecord,
  WithdrawalRecord,
} from "../app/funding/requests/model";
import { requestRefOf } from "../app/utils/request-index";
import { awaitingDepositCryptoRecord, FIXTURE_NOW } from "./fixtures/requests";

const calls = vi.hoisted(() => ({ log: [] as string[] }));

vi.mock("~~/lib/telemetry", async () => ({
  // the real rule for which failures are the person's own answer
  isExpected: (
    await vi.importActual<typeof import("../lib/telemetry/catalogue")>("../lib/telemetry/catalogue")
  ).isExpected,
  startJourney: (name: string, attrs: Record<string, string>) => {
    calls.log.push(`start ${name} ${attrs["request.route"]}`);
    return {
      name,
      ended: false,
      trace: null,
      step: (step: string) => {
        calls.log.push(`step ${step}`);
        return { ended: false, set() {}, end: () => calls.log.push(`end-step ${step}`) };
      },
      set() {},
      markSad: (reason: string) => calls.log.push(`sad ${reason}`),
      end: (outcome: string) => calls.log.push(`end ${outcome}`),
      interrupt() {},
    };
  },
  reportFailure: (kind: string, details: { reason: string }, journey?: unknown) =>
    calls.log.push(`failure ${kind} ${details.reason}${journey ? "" : " (no journey)"}`),
}));

const { requestChanged, requestCreated } = await import("../app/funding/requests/telemetry");

let tradeN = 100;
function topUp(): TopUpRecord {
  const record = migrateRecord(
    awaitingDepositCryptoRecord,
    requestRefOf("dot-assethub", ++tradeN),
    FIXTURE_NOW,
  );
  if (record === null || record.kind !== "top-up") throw new Error("fixture did not migrate");
  return record;
}
const moved = (record: TopUpRecord, status: RequestStatus, more: Partial<TopUpRecord> = {}) =>
  ({ ...record, ...more, status, rev: record.rev + 1 }) as RequestRecord;

beforeEach(() => {
  calls.log = [];
});

describe("a top-up's journey", () => {
  it("As a developer reading Sentry, I follow a top-up made on this page from its deposit to the purse, step by step", () => {
    // Given
    const created = topUp();
    requestCreated(created);

    // When
    // the provider reports it received the deposit; it is not on the account yet
    const seen = moved(created, {
      kind: "deposit-seen",
      at: 1,
      assurance: "provisional",
      via: "core",
    });
    requestChanged(created, seen);
    const converting = moved(created, { kind: "converting", at: 2, step: "swap" });
    requestChanged(seen, converting);
    const claiming = moved(created, { kind: "claiming", at: 3 });
    requestChanged(converting, claiming);
    requestChanged(claiming, moved(created, { kind: "settled", at: 4 }));

    // Then
    expect(calls.log).toEqual([
      "start top-up crypto",
      "step deposit",
      "end-step deposit",
      "step arrive",
      "end-step arrive",
      "step convert",
      "end-step convert",
      "step claim",
      "end-step claim",
      "end settled",
    ]);
  });

  it("As a person whose BTC deposit is confirming, I wait on the provider and the app is never called stuck meanwhile", async () => {
    // Given
    const { JOURNEYS } = await vi.importActual<typeof import("../lib/telemetry/catalogue")>(
      "../lib/telemetry/catalogue",
    );

    // Then: a seen deposit's step waits on the provider, as the deposit itself waits on the person
    expect(JOURNEYS["top-up"].waitSteps).toContain("arrive");
    expect(JOURNEYS["top-up"].waitSteps).not.toContain("convert");
  });

  it("As a developer reading Sentry, I see the wait on the provider end when the deposit reaches the account, though its status stays deposit-seen", () => {
    // Given: the provider reported the deposit
    const created = topUp();
    requestCreated(created);
    const seen = moved(created, {
      kind: "deposit-seen",
      at: 1,
      assurance: "provisional",
      via: "core",
    });
    requestChanged(created, seen);

    // When: the worker sees it on the account; the status only gains assurance
    const landed = moved(
      created,
      { kind: "deposit-seen", at: 1, assurance: "finalized", via: "core" },
      {
        witnesses: {
          worker: { known: true, phase: "swap", done: false, fundsSeenAt: 2, lastTickAt: 2, at: 2 },
        },
      },
    );
    requestChanged(seen, landed);

    // Then: from here the swap is the app's to move, so a stall would be reported
    expect(calls.log).toEqual([
      "start top-up crypto",
      "step deposit",
      "end-step deposit",
      "step arrive",
      "end-step arrive",
      "step convert",
    ]);
  });

  it("As a developer reading Sentry, I see a direct deposit the app read on the account go straight to the app's own step", () => {
    // Given
    const created = topUp();
    requestCreated(created);

    // When
    requestChanged(
      created,
      moved(
        created,
        { kind: "deposit-seen", at: 1, assurance: "provisional", via: "chain" },
        { observedAt: { "on-burner": 1 } },
      ),
    );

    // Then
    expect(calls.log).toEqual([
      "start top-up crypto",
      "step deposit",
      "end-step deposit",
      "step convert",
    ]);
  });

  it("As a developer reading Sentry, I see a recoverable failure once, its journey left open on retry, and a later recovery carried on", () => {
    // Given
    const created = topUp();
    requestCreated(created);
    const failure = {
      kind: "mint",
      step: "mint",
      message: "the PSM refused",
      recoverable: true,
    } as const;
    const failed = moved(created, { kind: "failed", at: 5, recoverable: true }, { failure });

    // When
    requestChanged(created, failed);
    requestChanged(created, { ...failed, rev: failed.rev + 1 });
    requestChanged(failed, moved(created, { kind: "converting", at: 6, step: "swap" }));

    // Then
    expect(calls.log).toEqual([
      "start top-up crypto",
      "step deposit",
      "failure top-up-failed mint",
      "end-step deposit",
      "sad failed:mint",
      "step retry",
      "end-step retry",
      "step convert",
    ]);
  });

  it("As a developer reading Sentry, I get the failure of a top-up resumed from an earlier open, without a journey of its own", () => {
    // Given
    const resumed = topUp();

    // When
    requestChanged(resumed, moved(resumed, { kind: "failed", at: 7, recoverable: false }));

    // Then
    expect(calls.log).toEqual(["failure top-up-failed unknown (no journey)"]);
  });

  it("As a person who changed their mind, I cancel my top-up and the journey ends as cancelled, with no failure sent", () => {
    // Given
    const created = topUp();
    requestCreated(created);

    // When
    requestChanged(created, moved(created, { kind: "cancelled", at: 8 }));

    // Then
    expect(calls.log).toEqual([
      "start top-up crypto",
      "step deposit",
      "end-step deposit",
      "end cancelled",
    ]);
  });
});

describe("a withdrawal's failures", () => {
  /** A withdrawal record as far as the telemetry reads one. */
  const withdrawal = (over: Partial<WithdrawalRecord>): WithdrawalRecord =>
    ({
      kind: "withdrawal",
      ref: requestRefOf("wd:pas-assethub", ++tradeN),
      rev: 1,
      route: "crypto",
      destination: {
        chain: "Asset Hub",
        asset: "PAS",
        address: "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5",
      },
      key: {
        label: "wd",
        address: "1jN9roH2QfHPSCurNcuCz4V58fXS2HPTGidJGQnT7dPthdZ",
        publicKeyHex: "0x07",
      },
      payment: { attempt: 0 },
      status: { kind: "awaiting-payment" },
      rail: { provider: "direct", stage: "waiting", updatedAt: 0 },
      witnesses: {},
      ...over,
    }) as WithdrawalRecord;
  const declinedAt = (step: "payment" | "convert", refusal: "declined" | "other") =>
    withdrawal({
      status: { kind: "failed", at: 9, recoverable: true },
      failure: { kind: "payment-failed", step, message: "no", recoverable: true },
      payment: { attempt: 0, status: "failed", refusal },
    });

  it("As a developer reading Sentry, I see a person declining the payment sheet as their own answer, and any other payment failure as ours", () => {
    // Given
    const asked = withdrawal({});

    // When
    requestChanged(asked, declinedAt("payment", "declined"));
    requestChanged(asked, declinedAt("payment", "other"));
    requestChanged(asked, declinedAt("convert", "declined"));

    // Then
    expect(calls.log).toEqual([
      "failure payment-refused declined (no journey)",
      "failure withdraw-failed payment-failed (no journey)",
      "failure withdraw-failed payment-failed (no journey)",
    ]);
  });

  it("As a person who declined the payment sheet, my withdrawal waits for my retry and is not counted as something that went wrong", () => {
    // Given: a withdrawal made on this page
    const asked = withdrawal({});
    requestCreated(asked);
    const declined = {
      ...asked,
      rev: 2,
      status: { kind: "failed", at: 9, recoverable: true },
      failure: { kind: "payment-failed", step: "payment", message: "no", recoverable: true },
      payment: { attempt: 0, status: "failed", refusal: "declined" },
    } as WithdrawalRecord;

    // When
    requestChanged(asked, declined);

    // Then
    expect(calls.log).toEqual([
      "start withdraw crypto",
      "step payment",
      "failure payment-refused declined",
      "end-step payment",
      "step retry",
    ]);
  });
});
