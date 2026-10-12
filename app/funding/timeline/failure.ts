// A failed top-up as the journey words it: the text under the timeline, the action, and the
// failure details rows.

import type { TopUpRecord } from "../requests/model";

/** Where the money to get back is: on the refund key the provider returned it to, or on the
 *  top-up's own account. */
export type GetBackFrom = "refund-key" | "deposit-account";

export type FailureAction =
  | { readonly kind: "start-over" }
  /** Runs the Polkadot part again with the same funds. */
  | { readonly kind: "try-again" }
  | { readonly kind: "get-back"; readonly source: string; readonly from: GetBackFrom }
  | { readonly kind: "close" };

/** The failure details rows, each absent when the record has no value for it. */
export interface FailureDetails {
  readonly provider?: string;
  readonly reason?: string;
  /** A raw identifier: the provider's reference for the payment. */
  readonly reference?: string;
}

/** What the part of the timeline that failed says about it. */
export interface PartFailure {
  readonly text: string;
  readonly action: FailureAction;
}

export interface TimelineFailure extends PartFailure {
  readonly details: FailureDetails;
}

export const START_OVER: FailureAction = { kind: "start-over" };
export const TRY_AGAIN: FailureAction = { kind: "try-again" };
export const CLOSE: FailureAction = { kind: "close" };

/** The ending's own code, as core or the rail kept it. */
export const failureCode = (record: TopUpRecord): string | undefined =>
  record.failure?.code ?? record.rail.failure?.code;

/** The deposit window closed: the clock, the worker or the rail ended the top-up unpaid. */
export const expiredEnding = (record: TopUpRecord): boolean =>
  record.status.kind === "expired" ||
  record.failure?.kind === "expired" ||
  record.failure?.kind === "stale";

/** The wording of an expired crypto top-up, from before the timeline. */
export const CRYPTO_EXPIRED_TEXT = "This top-up expired because no funds arrived in time.";

/** `text` followed by the provider's reason, when it gave one. */
export const withReason = (text: string, reason: string | undefined): string =>
  reason === undefined ? `${text}.` : `${text}: ${reason}`;
