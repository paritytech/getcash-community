// The ending rule the journey reads: whether a top-up expired.

import { describe, expect, it } from "vitest";
import { isExpiredEnding } from "../app/funding/journey-endings";
import { DEPOSIT_EXPIRED_REASON } from "../app/funding/requests/model";

describe("journey endings", () => {
  it("names an expired top-up from its own failure", () => {
    expect(isExpiredEnding("expired", null)).toBe(true);
    expect(isExpiredEnding("stale", null)).toBe(true);
    expect(isExpiredEnding(undefined, DEPOSIT_EXPIRED_REASON)).toBe(true);
    // A named ending is not an expiry: it keeps its quote rows, which an expiry drops.
    expect(isExpiredEnding("deposit-rejected", "Top-up didn't go through.")).toBe(false);
    expect(isExpiredEnding(undefined, null)).toBe(false);
  });
});
