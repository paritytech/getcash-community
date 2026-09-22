// The module the whole estimate-versus-exact guarantee rests on: every screen that shows the
// committed crypto or the estimated payout goes through these two functions, so a bug here is a
// bug everywhere at once. Pinned directly, rather than only indirectly through a component.

import { describe, expect, it } from "vitest";
import {
  formatCommittedCrypto,
  formatEstimatedPayout,
  meldSellDestination,
  meldSentMessage,
  meldWithdrawDestinationId,
} from "../app/withdraw/meld-sell";

describe("formatCommittedCrypto", () => {
  it("formats planck as whole-token DOT, trailing zeros trimmed, and never marks it as an estimate", () => {
    expect(formatCommittedCrypto("125000000000")).toBe("12.5 DOT");
    expect(formatCommittedCrypto("900000000")).toBe("0.09 DOT");
    expect(formatCommittedCrypto("50000000000")).toBe("5 DOT");
    for (const value of ["125000000000", "900000000", "50000000000"]) {
      expect(formatCommittedCrypto(value)).not.toContain("≈");
    }
  });
});

describe("formatEstimatedPayout", () => {
  it("always carries the estimate mark, for every currency it can format", () => {
    expect(formatEstimatedPayout("150.30", "USD")).toBe("≈ $150.30");
    expect(formatEstimatedPayout("150.30", "EUR")).toBe("≈ €150.30");
  });

  it("falls back to the raw amount and currency for a malformed or blank figure, rather than a fabricated number", () => {
    // A provider figure that does not parse must never render as a confident "$NaN" — the same
    // guard `fmtFiat` applies for every other fiat figure on this surface.
    expect(formatEstimatedPayout("", "USD")).toBe("≈  USD");
    expect(formatEstimatedPayout("not-a-number", "USD")).toBe("≈ not-a-number USD");
    expect(formatEstimatedPayout("150.30", "USD")).not.toContain("NaN");
  });
});

describe("meldSellDestination / meldWithdrawDestinationId", () => {
  it("names a Meld withdrawal's non-address destination by its payout method", () => {
    expect(meldWithdrawDestinationId("card")).toBe("meld-card");
    expect(meldWithdrawDestinationId("bank")).toBe("meld-bank");
    expect(meldSellDestination("bank")).toEqual({
      chain: "Meld",
      asset: "Bank",
      address: "Your bank account",
    });
    expect(meldSellDestination("card")).toEqual({
      chain: "Meld",
      asset: "Card",
      address: "Your card",
    });
  });
});

describe("meldSentMessage", () => {
  it("names the payout method instead of an address, since a payout has none to shorten", () => {
    expect(meldSentMessage("bank")).toBe("Paid to your bank account");
    expect(meldSentMessage("card")).toBe("Paid to your card");
  });
});
