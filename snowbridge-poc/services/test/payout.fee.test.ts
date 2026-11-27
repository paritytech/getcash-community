import { describe, expect, it } from "vitest";
import { computeFee } from "../src/payout/fee";

const ONE = 10n ** 18n;
const params = { bridgeFee: ONE / 1000n, frontFeeBps: 10, capBps: 100 };

describe("front fee", () => {
  it("is the bridge fee plus the configured bps of the amount", () => {
    expect(computeFee(100n * ONE, params)).toBe(ONE / 1000n + ONE / 10n);
  });

  it("never asks for more than the pool's cap", () => {
    const greedy = { ...params, frontFeeBps: 500 };
    expect(computeFee(100n * ONE, greedy)).toBe(ONE / 1000n + ONE);
  });

  it("rounds the bps part down so it stays inside the cap", () => {
    expect(computeFee(999n, { bridgeFee: 0n, frontFeeBps: 100, capBps: 100 })).toBe(9n);
    expect(computeFee(9_999n, { bridgeFee: 5n, frontFeeBps: 1, capBps: 1 })).toBe(5n);
  });

  it("is only the bridge fee when the bps is zero", () => {
    expect(computeFee(100n * ONE, { ...params, frontFeeBps: 0 })).toBe(ONE / 1000n);
  });

  it("is undefined when the deposit cannot carry the fee", () => {
    expect(computeFee(ONE / 1000n, params)).toBeUndefined();
    expect(computeFee(ONE / 1000n - 1n, params)).toBeUndefined();
    expect(computeFee(0n, params)).toBeUndefined();
  });

  it("satisfies the pool's range check for a spread of amounts", () => {
    for (const amount of [1_001n, 12_345_678n, ONE, 7n * ONE + 13n, 10n ** 30n + 1n]) {
      for (const frontFeeBps of [0, 1, 10, 99, 100, 250]) {
        const fee = computeFee(amount, { ...params, frontFeeBps });
        if (fee === undefined) continue;
        expect(fee).toBeGreaterThanOrEqual(params.bridgeFee);
        expect(fee).toBeLessThan(amount);
        expect(fee - params.bridgeFee).toBeLessThanOrEqual((amount * BigInt(params.capBps)) / 10_000n);
      }
    }
  });
});
