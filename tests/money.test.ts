import { describe, expect, it } from "vitest";
import { fmtFiat, isMoneyAmount } from "../app/utils/money";

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
