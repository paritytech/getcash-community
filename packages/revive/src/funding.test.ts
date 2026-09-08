import { describe, expect, it } from "vitest";
import {
  DUST_GUARD_PLANCKS,
  hasEnoughBalance,
  priceEvmToPlancks,
  requiredDeposit,
  shouldSweepDust,
} from "./funding";

describe("funding economics", () => {
  it("priceEvmToPlancks scales /10^8 (EVM 18-dec -> chain 10-dec)", () => {
    expect(priceEvmToPlancks(1_000_000_000_000_000_000n)).toBe(10_000_000_000n);
    expect(priceEvmToPlancks(0n)).toBe(0n);
  });

  it("requiredDeposit = plancks + 0.3 DOT default overhead", () => {
    // 5 DOT price (EVM) -> 50e9 plancks + 3e9 overhead.
    expect(requiredDeposit(5_000_000_000_000_000_000n)).toBe(53_000_000_000n);
  });

  it("requiredDeposit honors a custom overhead", () => {
    expect(requiredDeposit(1_000_000_000_000_000_000n, 0n)).toBe(10_000_000_000n);
  });

  it("hasEnoughBalance is a >= gate", () => {
    expect(hasEnoughBalance(53_000_000_000n, 53_000_000_000n)).toBe(true);
    expect(hasEnoughBalance(52_999_999_999n, 53_000_000_000n)).toBe(false);
  });

  it("dust guard boundary: exactly 0.1 DOT is dust (no sweep); one planck over sweeps", () => {
    expect(DUST_GUARD_PLANCKS).toBe(1_000_000_000n);
    expect(shouldSweepDust(1_000_000_000n)).toBe(false);
    expect(shouldSweepDust(1_000_000_001n)).toBe(true);
    expect(shouldSweepDust(0n)).toBe(false);
  });
});
