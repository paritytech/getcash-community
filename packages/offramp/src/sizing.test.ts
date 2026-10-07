import { describe, expect, it } from "vitest";
import { saleFloor } from "./sizing";

describe("saleFloor", () => {
  it("is the quoted output less the slippage, rounded down", () => {
    expect(saleFloor(99_150_000n, 30)).toBe(98_852_550n);
    expect(saleFloor(7n, 5_000)).toBe(3n);
    expect(saleFloor(7n, 0)).toBe(7n);
  });

  it("rejects nonsense inputs", () => {
    expect(() => saleFloor(0n, 30)).toThrow();
    expect(() => saleFloor(1n, -1)).toThrow();
    expect(() => saleFloor(1n, 10_000)).toThrow();
    expect(() => saleFloor(1n, 0.5)).toThrow();
  });
});
