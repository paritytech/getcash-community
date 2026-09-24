// The ending rules the journey reads: what the stepper calls a failure, and what the bank
// transfer says about one the adapter worded for a card.

import { describe, expect, it } from "vitest";
import { bankEndingText, endingLabel, isExpiredEnding } from "../app/funding/journey-endings";
import { DEPOSIT_EXPIRED_REASON } from "../app/funding/requests/model";

describe("journey endings", () => {
  it("names an expired top-up from its own failure, not from the stepper's label", () => {
    expect(isExpiredEnding("expired", null)).toBe(true);
    expect(isExpiredEnding("stale", null)).toBe(true);
    expect(isExpiredEnding(undefined, DEPOSIT_EXPIRED_REASON)).toBe(true);
    // A named ending is not an expiry: it keeps its quote rows, which an expiry drops.
    expect(isExpiredEnding("deposit-rejected", "Top-up didn't go through.")).toBe(false);
    expect(isExpiredEnding(undefined, null)).toBe(false);
  });

  it("gives each rail ending its own step name", () => {
    expect(endingLabel(true, null)).toBe("Expired");
    // An expiry outranks whatever the rail called it.
    expect(endingLabel(true, "declined")).toBe("Expired");
    expect(endingLabel(false, "declined")).toBe("Payment declined");
    expect(endingLabel(false, "refunded")).toBe("Refunded");
    // A plain failure keeps the stepper's own "<stage> failed".
    expect(endingLabel(false, "failed")).toBeNull();
    expect(endingLabel(false, "unobserved")).toBeNull();
    expect(endingLabel(false, null)).toBeNull();
  });

  it("words the endings the adapter wrote for a card as a transfer's own", () => {
    expect(bankEndingText("declined", "€50.55")).toBe(
      "Your bank rejected the transfer. Check with your bank or try another account.",
    );
    expect(bankEndingText("refunded", "€50.55")).toBe(
      "Your €50.55 has been returned to your bank account.",
    );
    // No quote to name the charge: the sentence still stands.
    expect(bankEndingText("refunded", null)).toBe(
      "Your transfer has been returned to your bank account.",
    );
    // The adapter's own message already fits these, so nothing is invented over it.
    expect(bankEndingText("failed", "€50.55")).toBeNull();
    expect(bankEndingText("unobserved", "€50.55")).toBeNull();
    expect(bankEndingText(null, "€50.55")).toBeNull();
  });
});
