import { describe, expect, it } from "vitest";
import { FIXED_POINT_SCALE } from "./constants";
import {
  addXcmFeeMargin,
  deliveryFeeForEncodedXcm,
  formatPUsd,
  nativeFeeToPUsd,
  quoteExactOutput,
} from "./quote";

describe("withdrawal quote arithmetic", () => {
  it("keeps AssetConversion exact-output rounding in base units", () => {
    expect(quoteExactOutput(997n, 2_000n, 1_000n)).toBe(1_000n);
    expect(quoteExactOutput(1_000n, 10n, 1n)).toBe(112n);
  });

  it("rejects unusable exact-output pool requests", () => {
    expect(() => quoteExactOutput(1_000n, 10n, 0n)).toThrow(/pool liquidity/);
    expect(() => quoteExactOutput(1_000n, 10n, 10n)).toThrow(/pool liquidity/);
  });

  it("sizes delivery fees from encoded length and delivery factor", () => {
    expect(deliveryFeeForEncodedXcm(100, FIXED_POINT_SCALE)).toBe(316_400_000n);
    expect(deliveryFeeForEncodedXcm(100, 2n * FIXED_POINT_SCALE)).toBe(632_800_000n);
    expect(addXcmFeeMargin(632_800_000n)).toBe(759_360_000n);
  });

  it("converts native partial fees to pUSD with fixed-point ceiling", () => {
    expect(nativeFeeToPUsd(5n, 2n * FIXED_POINT_SCALE)).toBe(3n);
    expect(nativeFeeToPUsd(12n, 3n * FIXED_POINT_SCALE)).toBe(4n);
  });

  it("formats six-decimal pUSD base units for user-facing errors", () => {
    expect(formatPUsd(1_000_000n)).toBe("1");
    expect(formatPUsd(1_234_500n)).toBe("1.2345");
    expect(formatPUsd(1n)).toBe("0.000001");
  });
});
