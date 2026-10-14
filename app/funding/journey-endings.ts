// How a top-up's ending is named on the journey, and the amount its header shows.

import type { FailureKind } from "@getsome/core";
import { DEPOSIT_EXPIRED_REASON } from "./requests/model";

/** Whether the top-up ended because nothing arrived in time. An expired top-up was never paid, so
 *  it keeps no quote rows. */
export function isExpiredEnding(
  kind: FailureKind | undefined,
  fundingError: string | null,
): boolean {
  return kind === "expired" || kind === "stale" || fundingError === DEPOSIT_EXPIRED_REASON;
}

/** How a top-up ended, for the journey's header. */
export type JourneyEnding = "success" | "failure";

/** The figures the journey's header chooses from, formatted. */
export interface HeaderAmounts {
  /** What the buyer asked for. */
  readonly asked: string;
  /** What the Host credited, once the top-up ended with a credit. */
  readonly credited?: string;
  /** A bank transfer's claim that differs from what was asked. The transfer can take days, so the
   *  header shows it before the end. */
  readonly revised?: string | null;
}

/** The journey's header amount: what the buyer asked for until the top-up ends, then what the Host
 *  credited, with a plus on success. */
export function headerAmount(
  ending: JourneyEnding | null,
  { asked, credited, revised }: HeaderAmounts,
): { sign: "" | "+"; amount: string } {
  const owed = revised ?? asked;
  if (ending === null) return { sign: "", amount: owed };
  return { sign: ending === "success" ? "+" : "", amount: credited ?? owed };
}
