// Reads a stored record into the schema 2 shape. A legacy `ActiveFlowRecord` is upgraded from
// its fields, which are kept as they are; a schema 2 record is taken as stored, with any missing
// additive field filled by the same rules.

import type { ActiveFlowRecord } from "../../stores/session";
import { toCashBase } from "../../utils/cash";
import type { RequestRef } from "../../utils/request-index";
import { progressProviderForSource, resolveFundingProgressSnapshot } from "../progress";
import {
  DEFAULT_DEPOSIT_WINDOW_MS,
  DEPOSIT_EXPIRED_REASON,
  effectiveSourceId,
  railProviderOf,
  routeOf,
  type RequestFailure,
  type RequestRecord,
  type RequestStatus,
} from "./model";
import type { FundingProgressSnapshot } from "../progress";

/** A stored record of either schema; only the legacy fields are trusted before migration. */
type StoredRecord = ActiveFlowRecord & { schema?: unknown };

/** Today's `readAllRequests` validity rule: an object with a parseable amount. */
function isStoredRecord(raw: unknown): raw is StoredRecord {
  if (typeof raw !== "object" || raw === null) return false;
  const { amountHuman } = raw as { amountHuman?: unknown };
  return typeof amountHuman === "string" && toCashBase(amountHuman) !== null;
}

/** Null only when `raw` is not a record with a parseable `amountHuman`. */
export function migrateRecord(raw: unknown, ref: RequestRef, now: number): RequestRecord | null {
  if (!isStoredRecord(raw)) return null;
  const upgraded = upgradeLegacyRecord(raw, ref, now);
  if (raw.schema !== 2) return upgraded;
  // Stored additive fields win; the upgrade fills whatever a partial write left out. The stored
  // progress is the app's own record of it, normalised but never advanced; the funded guess is
  // for legacy records. The key the record was read under is its identity.
  const stored = raw as Partial<RequestRecord> & ActiveFlowRecord;
  const progress =
    stored.progress === undefined
      ? upgraded.progress
      : resolveFundingProgressSnapshot(
          stored.progress,
          progressProviderForSource(effectiveSourceId(ref)).createProfile(),
        );
  return { ...upgraded, ...stored, schema: 2, ref, progress };
}

function upgradeLegacyRecord(raw: ActiveFlowRecord, ref: RequestRef, now: number): RequestRecord {
  const sourceId = effectiveSourceId(ref);
  const progress = resolveFundingProgressSnapshot(
    raw.progress,
    progressProviderForSource(sourceId).createProfile(),
    { fundedAt: raw.funded, settledAt: raw.settledAt },
  );
  const { status, failure } = legacyStatus(raw, progress);
  return {
    ...raw,
    schema: 2,
    kind: "top-up",
    ref,
    rev: 0,
    updatedAt: now,
    progress,
    route: routeOf(sourceId),
    ...(raw.depositAddress
      ? {
          deposit: {
            address: raw.depositAddress,
            amount: "0",
            formatted: "",
            assetSymbol: "",
            expiresAt: raw.depositExpiresAt ?? 0,
          },
        }
      : {}),
    deadline: {
      depositExpiresAt: raw.depositExpiresAt ?? raw.startedAt + DEFAULT_DEPOSIT_WINDOW_MS,
      source: raw.depositExpiresAt ? "rail" : "route",
    },
    status,
    rail: {
      provider: railProviderOf(sourceId),
      status: "waiting",
      stage: "waiting",
      updatedAt: raw.startedAt,
    },
    ...(failure ? { failure } : {}),
    witnesses: {},
  };
}

/** What the legacy fields say the request is doing, first match wins. */
function legacyStatus(
  raw: ActiveFlowRecord,
  progress: FundingProgressSnapshot,
): { status: RequestStatus; failure?: RequestFailure } {
  if (raw.settledAt !== undefined) return { status: { kind: "settled", at: raw.settledAt } };
  if (raw.cancelledAt !== undefined) return { status: { kind: "cancelled", at: raw.cancelledAt } };
  if (raw.failureReason === DEPOSIT_EXPIRED_REASON) {
    return { status: { kind: "expired", at: raw.startedAt } };
  }
  if (raw.failureReason !== undefined) {
    return {
      status: { kind: "failed", at: progress.failedAt ?? raw.startedAt, recoverable: false },
      failure: {
        kind: raw.refunded ? "refunded" : "unknown",
        step: "deposit",
        message: raw.failureReason,
        recoverable: false,
        ...(raw.refunded === undefined ? {} : { refunded: raw.refunded }),
        // A legacy record kept the refund's figures flat; the record keeps them on the failure.
        ...(raw.refundAmount === undefined && raw.refundTxRef === undefined
          ? {}
          : {
              refund: {
                ...(raw.refundAmount === undefined ? {} : { amount: raw.refundAmount }),
                ...(raw.refundTxRef === undefined ? {} : { txRef: raw.refundTxRef }),
              },
            }),
      },
    };
  }
  if (raw.funded !== undefined) {
    return {
      status: { kind: "deposit-seen", at: raw.funded, assurance: "finalized", via: "worker" },
    };
  }
  return { status: { kind: "awaiting-deposit" } };
}
