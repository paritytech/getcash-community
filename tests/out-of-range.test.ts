import { describe, expect, it } from "vitest";
import { cryptoBelowMinimum, fiatOutOfRange } from "../app/funding/out-of-range";

describe("fiatOutOfRange", () => {
  const range = { limit: "40.00", estimatedFiat: "19.68", fiat: "GBP" };

  it("names the minimum in CASH, and offers it", () => {
    expect(
      fiatOutOfRange({ ...range, bound: "min", cash: "50" }, "card", "United Kingdom"),
    ).toEqual({
      message: "You need at least $50 CASH for card payment in United Kingdom",
      rows: [{ label: "Min. payment", value: "50", cash: true }],
      bound: "50",
    });
  });

  it("names the maximum in CASH, and offers it", () => {
    expect(fiatOutOfRange({ ...range, bound: "max", cash: "4000" }, "bank", "Portugal")).toEqual({
      message: "You can pay at most $4000 CASH by bank payment in Portugal",
      rows: [{ label: "Max. payment", value: "4000", cash: true }],
      bound: "4000",
    });
  });

  it("names the bound in fiat when it could not be scaled, offering nothing", () => {
    expect(
      fiatOutOfRange({ ...range, bound: "min", cash: null }, "card", "United Kingdom"),
    ).toEqual({
      message: "Below the minimum for card payment in United Kingdom",
      rows: [{ label: "Min. payment", value: "£40.00" }],
      bound: null,
    });
  });
});

describe("cryptoBelowMinimum", () => {
  it("rounds the provider's minimum up to whole CASH and offers it", () => {
    expect(cryptoBelowMinimum(49_200_000n)).toEqual({
      message: "You need at least $50 CASH for crypto payout for this token",
      rows: [{ label: "Min. payout", value: "50", cash: true }],
      bound: "50",
    });
  });
});
