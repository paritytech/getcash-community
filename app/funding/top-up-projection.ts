// Shared top-up adapter helpers: fold the live request status onto the persisted progress
// snapshot, derive the shell state, and format the credited amount.

import type { RequestStatus } from "../stores/session";
import { fmtCash } from "../utils/cash";
import {
  advanceFundingProgressSnapshot,
  fundingProgressSignalForSharedStep,
  type FundingProgressProjection,
  type FundingProgressSnapshot,
} from "./progress";
import type { FundingTopUp } from "./top-ups";

/** The durable request record as the adapters read it. */
export interface FundingTopUpRecord {
  amountHuman: string;
  startedAt: number;
  chain?: string;
  asset?: string;
  depositAddress?: string;
  tradeN?: number;
  /** The session's source id. */
  sourceId?: string;
  /** What the buyer pays, as the rail quoted it: fiat for Meld, the source coin for crypto. */
  sourceAmount?: string;
  sourceSymbol?: string;
  /** The Meld rail's buyer country. */
  meldCountry?: string;
  funded?: number;
  settledAt?: number;
  claimed?: string;
  /** Why the request failed. */
  failureReason?: string;
  /** The failed swap was refunded to the request's own key. */
  refunded?: boolean;
  progress?: FundingProgressSnapshot;
}

export function applyLiveStatus(
  snapshot: FundingProgressSnapshot,
  status: RequestStatus | undefined,
  observedAt: number,
): FundingProgressSnapshot {
  switch (status?.kind) {
    case "converting":
      return advanceFundingProgressSnapshot(snapshot, {
        ...fundingProgressSignalForSharedStep(status.step),
        at: observedAt,
      });
    case "ready":
      return advanceFundingProgressSnapshot(snapshot, {
        ...fundingProgressSignalForSharedStep("done"),
        at: observedAt,
      });
    case "failed":
      // The transition keeps an existing failedAt; this timestamp only applies before the
      // persisted failure has landed.
      return advanceFundingProgressSnapshot(snapshot, {
        observation: { kind: "failed" },
        at: observedAt,
      });
    default:
      return snapshot;
  }
}

export function creditedAmount(record: FundingTopUpRecord): string {
  if (record.claimed === undefined) return record.amountHuman;
  try {
    return fmtCash(BigInt(record.claimed));
  } catch {
    return record.amountHuman;
  }
}

/** The shell state of a request that has not settled. `reason` is the live status's reason, else
 *  the record's persisted one, else nothing. */
export function activeState(
  status: RequestStatus | undefined,
  progress: FundingProgressProjection,
  persistedReason?: string,
  persistedRefunded?: boolean,
): FundingTopUp["state"] {
  if (status?.kind === "failed" || progress.view.kind === "failed") {
    const reason = status?.kind === "failed" ? status.reason : persistedReason;
    const refunded = (status?.kind === "failed" && status.refunded) || persistedRefunded === true;
    return {
      kind: "failed",
      ...(progress.failedAt === undefined ? {} : { at: progress.failedAt }),
      ...(reason === undefined ? {} : { reason }),
      ...(refunded ? { refunded } : {}),
    };
  }
  if (progress.view.kind === "waiting") {
    return { kind: "awaiting-transfer", status: progress.view.label };
  }
  return { kind: "finishing", status: progress.view.label };
}
