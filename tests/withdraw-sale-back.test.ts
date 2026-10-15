// What a fiat sale is expected to send back, as the quote shows it: to the cent, rounded down.

import { describe, expect, it } from "vitest";
import { backCashText } from "../app/withdraw/sale-back";

describe("what a sale sends back, on the quote", () => {
  it("is shown to the cent, rounded down, with its ticker", () => {
    expect(backCashText(6_470_969n)).toBe("$6.47 CASH");
    expect(backCashText(10_000n)).toBe("$0.01 CASH");
  });

  it("is not shown under a cent", () => {
    expect(backCashText(9_999n)).toBeNull();
    expect(backCashText(0n)).toBeNull();
  });
});
