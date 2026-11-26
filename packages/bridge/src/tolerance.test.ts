import { describe, expect, it } from "vitest";
import { lessTolerance } from "./tolerance";

describe("lessTolerance", () => {
  it.each<[bigint, bigint, bigint]>([
    [85_288_053n, 50n, 84_861_612n],
    [1_000_000n, 0n, 1_000_000n],
    [1_000_000n, 10_000n, 0n],
    [999n, 1n, 998n],
    [0n, 50n, 0n],
  ])("takes %d less %d basis points, rounded down, as %d", (amount, bps, expected) => {
    expect(lessTolerance(amount, bps)).toBe(expected);
  });

  it.each([-1n, 10_001n])("refuses a tolerance of %d basis points", (bps) => {
    expect(() => lessTolerance(1_000n, bps)).toThrow("not between 0 and 10000");
  });

  it("refuses a negative amount", () => {
    expect(() => lessTolerance(-1n, 50n)).toThrow("negative");
  });
});
