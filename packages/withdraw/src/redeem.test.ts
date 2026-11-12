// The redeem sized from what the key holds, held to the floors where the chain holds them: the
// PSM's minimum swap on the CASH going in, before its fee, and the stable account's minimum on
// what comes out.

import { describe, expect, it } from "vitest";
import { RedeemTooSmallError, sizeRedeem, type RedeemFloors } from "./redeem";

/** USDT through the PSM at 0.5%. */
const ROUTE = { tier: "psm", external: "USDT", feeRate: 5_000 } as const;
/** Paseo next's floors: the PSM redeems 1 CASH at least, a USDT account holds 0.07 at least, a
 *  CASH account one unit. */
const FLOORS: RedeemFloors = {
  cashMinBalance: 1n,
  externalMinBalance: 70_000n,
  minSwapAmount: 1_000_000n,
};
/** The batch's fee, 0.01 CASH. */
const FEE = 10_000n;
/** What stays on the key: the fee with its tenth of margin and the CASH account's minimum. */
const KEPT = 11_000n + 1n;

/** The floor a sizing was refused at, or null when it was not. */
function refusedAt(size: () => unknown): bigint | null {
  try {
    size();
  } catch (e) {
    if (e instanceof RedeemTooSmallError) return e.floor;
    throw e;
  }
  return null;
}

describe("sizing the redeem from what the key holds", () => {
  it("redeems the PSM's minimum though its fee takes what comes out under it", () => {
    expect(sizeRedeem(1_000_000n + KEPT, FEE, ROUTE, FLOORS)).toEqual({
      cashIn: 1_000_000n,
      net: 995_000n,
    });
  });

  it("refuses CASH in one unit under the PSM's minimum", () => {
    expect(refusedAt(() => sizeRedeem(999_999n + KEPT, FEE, ROUTE, FLOORS))).toBe(1_000_000n);
  });

  it("refuses what comes out under the stable account's minimum, whatever the PSM takes", () => {
    const floors = { ...FLOORS, minSwapAmount: 1n };
    // 70_000 in less 350 of fee is 69_650 out; 70_352 in less 352 is 70_000.
    expect(refusedAt(() => sizeRedeem(70_000n + KEPT, FEE, ROUTE, floors))).toBe(70_000n);
    expect(sizeRedeem(70_352n + KEPT, FEE, ROUTE, floors).net).toBe(70_000n);
  });
});
