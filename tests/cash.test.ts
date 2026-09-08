import { describe, expect, it } from "vitest";
import { fmtCash, fmtCashDisplay, toCashBase } from "../app/utils/cash";

describe("CASH formatting", () => {
  it("fmtCash trims to the shortest exact form", () => {
    expect(fmtCash(10_000_000n)).toBe("10");
    expect(fmtCash(18_750_000n)).toBe("18.75");
    expect(fmtCash(123_456n)).toBe("0.123456");
  });

  it("fmtCashDisplay keeps two decimals like a statement, more only when they carry value", () => {
    expect(fmtCashDisplay(10_000_000n)).toBe("10.00");
    expect(fmtCashDisplay(18_750_000n)).toBe("18.75");
    expect(fmtCashDisplay(10_500_000n)).toBe("10.50");
    expect(fmtCashDisplay(123_456n)).toBe("0.123456");
    expect(fmtCashDisplay(0n)).toBe("0.00");
  });

  it("round-trips through toCashBase", () => {
    for (const human of ["1", "0.5", "200", "18.75", "0.000001"]) {
      const base = toCashBase(human);
      expect(base).not.toBeNull();
      expect(toCashBase(fmtCashDisplay(base!))).toBe(base);
    }
  });
});
