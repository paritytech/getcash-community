// The pool math against the pallet's formulas, on the reserves People held when this was written.

import { describe, expect, it } from "vitest";
import { cashInFor, pasOutFor } from "./pool";

const reserves = { cash: 4_004_853_413n, pas: 9_987_917_550_000n };

describe("People pool math", () => {
  it("prices an exact CASH input the way the pallet does", () => {
    // (in * 997000 * pasReserve) / (cashReserve * 1e6 + in * 997000), floored.
    const cashIn = 500_000n;
    const expected =
      (cashIn * 997_000n * reserves.pas) / (reserves.cash * 1_000_000n + cashIn * 997_000n);
    expect(pasOutFor(cashIn, reserves)).toBe(expected);
    // Half a CASH bought about 0.1243 PAS at these reserves, as the live probe showed.
    expect(pasOutFor(cashIn, reserves) / 1_000_000n).toBe(1_243n);
  });

  it("prices an exact PAS output the way the pallet does, one unit up", () => {
    const pasOut = 1_000_000_000n;
    const expected =
      (reserves.cash * pasOut * 1_000_000n) / ((reserves.pas - pasOut) * 997_000n) + 1n;
    expect(cashInFor(pasOut, reserves)).toBe(expected);
  });

  it("prices an output at the least input that buys it", () => {
    for (const target of [1_000_000_000n, 318_000_000n, 1n]) {
      const cashIn = cashInFor(target, reserves);
      expect(pasOutFor(cashIn, reserves)).toBeGreaterThanOrEqual(target);
      // One unit less of input would not reach the target.
      expect(pasOutFor(cashIn - 1n, reserves)).toBeLessThan(target);
    }
  });

  it("refuses an empty pool and an output the pool cannot supply", () => {
    expect(() => pasOutFor(1n, { cash: 0n, pas: 1n })).toThrow(/empty/);
    expect(() => cashInFor(reserves.pas, reserves)).toThrow(/cannot supply/);
  });
});
