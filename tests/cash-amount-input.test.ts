import { describe, expect, it } from "vitest";
import { cashToAmountInput } from "../app/utils/cash";

describe("cashToAmountInput", () => {
  it("rounds a CASH balance down to the keypad's places and leaves whole numbers bare", () => {
    expect(cashToAmountInput(226_780_000n, 2)).toBe("226.78");
    expect(cashToAmountInput(1_239_999n, 2)).toBe("1.23");
    expect(cashToAmountInput(5_000_000n, 2)).toBe("5");
    expect(cashToAmountInput(5_500_000n, 2)).toBe("5.5");
    expect(cashToAmountInput(0n, 2)).toBe("0");
    expect(cashToAmountInput(226_780_000n, 0)).toBe("226");
    // More places than CASH carries pads with zeros, then trims them like any fraction.
    expect(cashToAmountInput(226_780_000n, 8)).toBe("226.78");
  });
});
