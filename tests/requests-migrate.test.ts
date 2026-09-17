// Migration of today's records into schema 2: total over the fixtures, never touching a legacy
// field or the ref.

import { describe, expect, it } from "vitest";
import { progressProviderForSource, resolveFundingProgressSnapshot } from "../app/funding/progress";
import { migrateRecord } from "../app/funding/requests/migrate";
import {
  DEFAULT_DEPOSIT_WINDOW_MS,
  effectiveSourceId,
  type RequestRecord,
  type RequestStatus,
} from "../app/funding/requests/model";
import { CRYPTO_SOURCE_ID } from "../app/funding/source-ids";
import type { ActiveFlowRecord } from "../app/stores/session";
import { requestRefKey, requestRefOf, type RequestRef } from "../app/utils/request-index";
import {
  awaitingDepositCryptoRecord,
  cancelledCryptoRecord,
  failedCryptoRecord,
  FIXTURE_NOW,
  fixtureRecords,
  fundedCryptoRecord,
  legacyBareRefRecord,
  settledCardRecord,
  submittedCardRecord,
} from "./fixtures/requests";

/** The ref a fixture is stored under: its own source id and trade number. */
const refOf = (record: ActiveFlowRecord): RequestRef =>
  requestRefOf(record.sourceId, record.tradeN!);

function migrated(record: ActiveFlowRecord, ref = refOf(record)): RequestRecord {
  const result = migrateRecord(record, ref, FIXTURE_NOW);
  if (result === null) throw new Error("fixture did not migrate");
  return result;
}

interface Expected {
  status: RequestStatus;
  route: RequestRecord["route"];
  provider: RequestRecord["rail"]["provider"];
  deadline: RequestRecord["deadline"];
}

describe("request record migration", () => {
  it("upgrades every fixture without changing ref or legacy fields", () => {
    const expected: Record<string, Expected> = {
      "dot-assethub#4": {
        status: {
          kind: "deposit-seen",
          at: fundedCryptoRecord.funded!,
          assurance: "finalized",
          via: "worker",
        },
        route: "crypto",
        provider: "manual",
        deadline: {
          depositExpiresAt: fundedCryptoRecord.startedAt + DEFAULT_DEPOSIT_WINDOW_MS,
          source: "route",
        },
      },
      "dot-assethub#3": {
        status: { kind: "awaiting-deposit" },
        route: "crypto",
        provider: "manual",
        deadline: {
          depositExpiresAt: awaitingDepositCryptoRecord.depositExpiresAt!,
          source: "rail",
        },
      },
      "meld-card#2": {
        status: { kind: "awaiting-deposit" },
        route: "card",
        provider: "meld",
        deadline: {
          depositExpiresAt: submittedCardRecord.startedAt + DEFAULT_DEPOSIT_WINDOW_MS,
          source: "route",
        },
      },
      "dot-assethub#2": {
        status: { kind: "failed", at: failedCryptoRecord.progress!.failedAt!, recoverable: false },
        route: "crypto",
        provider: "manual",
        deadline: {
          depositExpiresAt: failedCryptoRecord.startedAt + DEFAULT_DEPOSIT_WINDOW_MS,
          source: "route",
        },
      },
      "meld-card#1": {
        status: { kind: "settled", at: settledCardRecord.settledAt! },
        route: "card",
        provider: "meld",
        deadline: {
          depositExpiresAt: settledCardRecord.startedAt + DEFAULT_DEPOSIT_WINDOW_MS,
          source: "route",
        },
      },
      "dot-assethub#1": {
        status: { kind: "cancelled", at: cancelledCryptoRecord.cancelledAt! },
        route: "crypto",
        provider: "manual",
        deadline: { depositExpiresAt: cancelledCryptoRecord.depositExpiresAt!, source: "rail" },
      },
      "#7": {
        status: { kind: "awaiting-deposit" },
        route: "crypto",
        provider: "manual",
        deadline: {
          depositExpiresAt: legacyBareRefRecord.startedAt + DEFAULT_DEPOSIT_WINDOW_MS,
          source: "route",
        },
      },
    };
    expect(Object.keys(expected)).toHaveLength(fixtureRecords.length);

    for (const input of fixtureRecords) {
      const ref = refOf(input);
      const key = requestRefKey(ref);
      const record = migrated(input, ref);
      expect(record.schema, key).toBe(2);
      expect(record.kind, key).toBe("top-up");
      expect(record.ref, key).toBe(ref);
      expect(record.rev, key).toBe(0);
      expect(record.updatedAt, key).toBe(FIXTURE_NOW);
      expect(record.witnesses, key).toEqual({});
      expect(record.confirmedAt, key).toBeUndefined();

      const { progress, ...legacy } = input;
      for (const [field, value] of Object.entries(legacy)) {
        expect(record[field as keyof RequestRecord], `${key} ${field}`).toEqual(value);
      }
      expect(record.progress, key).toEqual(
        resolveFundingProgressSnapshot(
          progress,
          progressProviderForSource(effectiveSourceId(ref)).createProfile(),
          { fundedAt: input.funded, settledAt: input.settledAt },
        ),
      );

      const want = expected[key]!;
      expect(record.status, key).toEqual(want.status);
      expect(record.route, key).toBe(want.route);
      expect(record.rail, key).toEqual({
        provider: want.provider,
        status: "waiting",
        stage: "waiting",
        updatedAt: input.startedAt,
      });
      expect(record.deadline, key).toEqual(want.deadline);
      expect(record.deposit, key).toEqual({
        address: input.depositAddress,
        amount: "0",
        formatted: "",
        assetSymbol: "",
        expiresAt: input.depositExpiresAt ?? 0,
      });
    }

    expect(migrated(failedCryptoRecord).failure).toEqual({
      kind: "unknown",
      step: "deposit",
      message: failedCryptoRecord.failureReason,
      recoverable: false,
    });
    expect(migrated(cancelledCryptoRecord).failure).toBeUndefined();
  });

  it("bare legacy ref keeps its key and resolves to dot-assethub", () => {
    const ref: RequestRef = { tradeN: 7 };
    const record = migrated(legacyBareRefRecord, ref);
    expect(requestRefKey(record.ref)).toBe("#7");
    expect(record.ref).toEqual({ tradeN: 7 });
    expect(record.sourceId).toBeUndefined();
    expect(effectiveSourceId(record.ref)).toBe(CRYPTO_SOURCE_ID);
    expect(record.route).toBe("crypto");
    expect(record.rail.provider).toBe("manual");
    expect(record.progress.profile.id).toBe("chainflip");
    expect(record.progress.stageTimestamps).toEqual({});
    expect(record.deadline).toEqual({
      depositExpiresAt: legacyBareRefRecord.startedAt + DEFAULT_DEPOSIT_WINDOW_MS,
      source: "route",
    });
  });

  it("keeps the stored progress of a schema-2 record", () => {
    // The provider saw the card charge: `funded` is set while the progress stands at the payment
    // stage. A reload must not advance it to the conversion.
    const seen: RequestRecord = { ...migrated(submittedCardRecord), funded: FIXTURE_NOW - 60_000 };
    expect(seen.progress.confirmedStageKey).toBe("meld-payment");
    const reloaded = migrated(seen, seen.ref);
    expect(reloaded.progress).toEqual(seen.progress);
    expect(reloaded.progress.confirmedStageKey).toBe("meld-payment");
    expect(reloaded.progress.routeCompletedAt).toBeUndefined();
    expect(reloaded.progress.stageTimestamps["cash-conversion"]).toBeUndefined();

    // A legacy record has no better information: its funded stamp still guesses the conversion.
    expect(migrated(fundedCryptoRecord).progress.stageTimestamps["cash-conversion"]).toBe(
      fundedCryptoRecord.funded,
    );
  });

  it("rejects a record without a parseable amount", () => {
    const ref = refOf(awaitingDepositCryptoRecord);
    for (const amountHuman of ["abc", "0", "", "1.2345678"]) {
      expect(
        migrateRecord({ ...awaitingDepositCryptoRecord, amountHuman }, ref, FIXTURE_NOW),
        amountHuman,
      ).toBeNull();
    }
    const { amountHuman: _absent, ...withoutAmount } = awaitingDepositCryptoRecord;
    expect(migrateRecord(withoutAmount, ref, FIXTURE_NOW)).toBeNull();
    expect(migrateRecord(null, ref, FIXTURE_NOW)).toBeNull();
    expect(migrateRecord("25", ref, FIXTURE_NOW)).toBeNull();
    expect(
      migrateRecord({ ...awaitingDepositCryptoRecord, amountHuman: "2,5" }, ref, FIXTURE_NOW),
    ).not.toBeNull();
  });
});
