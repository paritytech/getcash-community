import { describe, expect, it } from "vitest";
import { fmtFiat, isMoneyAmount, splitFees } from "../app/utils/money";

describe("splitFees", () => {
  it("breaks a total into its provider and network shares", () => {
    expect(splitFees("3.42", "0.09")).toEqual({ provider: "3.33", network: "0.09" });
  });

  it("reports no split when the quote carries no usable network fee", () => {
    // The Fees screen keys its component rows off `network`: a null one means there is nothing to
    // break down, so it shows the total alone rather than restating it as a lone provider row.
    expect(splitFees("3.42", null)).toEqual({ provider: "3.42", network: null });
    expect(splitFees("3.42", undefined)).toEqual({ provider: "3.42", network: null });
    expect(splitFees("3.42", "0")).toEqual({ provider: "3.42", network: null });
    expect(splitFees("3.42", "")).toEqual({ provider: "3.42", network: null });
    // A network fee larger than the total is the provider contradicting itself; trust the total.
    expect(splitFees("3.42", "9.99")).toEqual({ provider: "3.42", network: null });
  });

  it("reports nothing at all when the total is not a number it can split", () => {
    expect(splitFees(null, "0.09")).toBeNull();
    expect(splitFees("about three quid", "0.09")).toBeNull();
  });
});

describe("fmtFiat", () => {
  it("formats a fiat amount symbol-first", () => {
    expect(fmtFiat("53.73", "GBP")).toBe("£53.73");
    expect(fmtFiat("50.05", "EUR")).toBe("€50.05");
  });

  it("keeps the plain amount-and-ticker form when it cannot format confidently", () => {
    // A blank rendered as "£0.00" would misstate a real charge.
    expect(fmtFiat("", "GBP")).toBe(" GBP");
    expect(fmtFiat("3.42", "NOT-A-CODE")).toBe("3.42 NOT-A-CODE");
  });

  it("still formats a crypto ticker Intl happens to accept, so callers must not pass one", () => {
    // "DOT" is well-formed enough for Intl, which then forces two fraction digits and destroys the
    // amount. The fiat-only contract is the caller's to keep: JourneyScreen routes crypto around
    // this on its own `q.crypto` flag rather than relying on a fallback here.
    // Intl separates a code-style currency with a non-breaking space.
    expect(fmtFiat("0.00004545", "DOT")).toBe("DOT\u00a00.00");
  });
});

describe("isMoneyAmount", () => {
  it("accepts plain decimal strings and rejects everything else", () => {
    expect(isMoneyAmount("3.42")).toBe(true);
    expect(isMoneyAmount("0")).toBe(true);
    expect(isMoneyAmount("")).toBe(false);
    expect(isMoneyAmount(null)).toBe(false);
    expect(isMoneyAmount("about three quid")).toBe(false);
  });
});
