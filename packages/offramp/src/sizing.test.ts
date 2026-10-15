import { describe, expect, it } from "vitest";
import { laneCommit, saleFloor } from "./sizing";

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

describe("laneCommit", () => {
  const lane = { slippageBps: 50, egressFeeHeadroom: 3 };

  it("keeps twice the quoted delivery fee more in hand, then takes the floor", () => {
    // 100 USDC quoted with a 0.32 fee: 99.36 kept, 0.5% under it.
    expect(laneCommit(lane, 100_000_000n, 320_000n)).toBe(saleFloor(99_360_000n, 50));
  });

  it("is the plain floor when the quote itemises no fee or the headroom is 1", () => {
    expect(laneCommit(lane, 100_000_000n, 0n)).toBe(saleFloor(100_000_000n, 50));
    expect(laneCommit({ slippageBps: 50, egressFeeHeadroom: 1 }, 100n, 30n)).toBe(99n);
  });

  it("is zero when the headroom takes the whole output", () => {
    expect(laneCommit(lane, 500n, 300n)).toBe(0n);
  });
});
