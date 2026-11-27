import { describe, expect, it } from "vitest";
import { ceilToTwoDecimals, formatTwoDecimals } from "./two-decimals";

describe("two-decimal figures", () => {
  it.each([
    { base: 0n, decimals: 6, rounded: 0n, printed: "0.00" },
    { base: 5_000_000n, decimals: 6, rounded: 5_000_000n, printed: "5.00" },
    { base: 10_100_000n, decimals: 6, rounded: 10_100_000n, printed: "10.10" },
    { base: 10_100_001n, decimals: 6, rounded: 10_110_000n, printed: "10.11" },
    { base: 10_099_999n, decimals: 6, rounded: 10_100_000n, printed: "10.10" },
    { base: 0n, decimals: 10, rounded: 0n, printed: "0.00" },
    { base: 123_400_000_000n, decimals: 10, rounded: 123_400_000_000n, printed: "12.34" },
    { base: 123_400_000_001n, decimals: 10, rounded: 123_500_000_000n, printed: "12.35" },
    { base: 123_399_999_999n, decimals: 10, rounded: 123_400_000_000n, printed: "12.34" },
    { base: 1n, decimals: 10, rounded: 100_000_000n, printed: "0.01" },
  ])(
    "rounds $base at $decimals decimals up to $printed",
    ({ base, decimals, rounded, printed }) => {
      expect(ceilToTwoDecimals(base, decimals)).toBe(rounded);
      expect(formatTwoDecimals(base, decimals)).toBe(printed);
      expect(formatTwoDecimals(rounded, decimals)).toBe(printed);
    },
  );
});
