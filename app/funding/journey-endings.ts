// How a top-up's ending is named and worded on the journey.
//
// Pure: the screen holds the record, these hold the rules. Kept apart because the ending decides
// two things at once, the line beneath the timeline and whether the quote rows survive, and
// reading one of those off the other is how they drift.

import type { FailureKind } from "@getsome/core";
import { DEPOSIT_EXPIRED_REASON } from "./requests/model";

/** The ending's own code as the Meld rail reported it (`declined`, `refunded`, `unobserved`, …). */
export type MeldEndingCode = string | null;

/** Whether the top-up ended because nothing arrived in time. An expired top-up was never paid, so
 *  it keeps no quote rows. */
export function isExpiredEnding(
  kind: FailureKind | undefined,
  fundingError: string | null,
): boolean {
  return kind === "expired" || kind === "stale" || fundingError === DEPOSIT_EXPIRED_REASON;
}

/**
 * The bank transfer's own wording for an ending the adapter words for a card, or null where the
 * adapter's own message already fits.
 *
 * The rail composes its message where the status is read, with no idea which method paid, and the
 * message is then persisted — so a transfer would otherwise be told to check its card details.
 * Worded here instead, off the ending's code, which also re-words the records already stored.
 *
 * `amount` is the charge as the screen prints it ("€50.55"); absent when no quote backs it.
 */
export function bankEndingText(code: MeldEndingCode, amount: string | null): string | null {
  switch (code) {
    case "declined":
      return "Your bank rejected the transfer. Check with your bank or try another account.";
    case "refunded":
      return amount
        ? `Your ${amount} has been returned to your bank account.`
        : "Your transfer has been returned to your bank account.";
    default:
      return null;
  }
}
