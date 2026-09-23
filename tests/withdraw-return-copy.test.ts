// The return's own copy: the one line that keeps an unwound sale from reading as a success, and
// the residue's honest bonus note. Pinned directly since nothing renders `record.return` without
// going through here.

import { describe, expect, it } from "vitest";
import type { WithdrawalReturnView } from "../app/funding/requests/model";
import { withdrawalReturnText } from "../app/withdraw/return-copy";

const base: WithdrawalReturnView = {
  reason: "unwind",
  phase: "await-native",
  returned: false,
  returnedAmount: null,
  nativeSeen: null,
  claim: null,
  txs: [],
};

describe("withdrawalReturnText", () => {
  it("says nothing while no return has started", () => {
    expect(withdrawalReturnText(undefined)).toBeNull();
  });

  it("never lets an unwind read as a payout, whichever phase it is in", () => {
    for (const text of [
      withdrawalReturnText(base),
      withdrawalReturnText({ ...base, returned: true, returnedAmount: "21000000" }),
      withdrawalReturnText({ ...base, phase: "left-below-floor", nativeSeen: "50000000" }),
    ]) {
      expect(text).not.toBeNull();
      expect(text).toMatch(/nothing was charged|left on-chain/i);
      expect(text).not.toMatch(/paid out|sold|received .* for/i);
    }
  });

  it("says the funds are moving, then that they arrived, for an unwind", () => {
    expect(withdrawalReturnText(base)).toBe(
      "Nothing was charged. We're moving your funds back to your balance.",
    );
    expect(withdrawalReturnText({ ...base, returned: true, returnedAmount: "21000000" })).toBe(
      "Nothing was charged. Your funds came back to your balance as CASH.",
    );
  });

  it("names a residue as extra CASH from the sale, never as the sale's own payout", () => {
    const residue: WithdrawalReturnView = {
      ...base,
      reason: "residue",
      returned: true,
      returnedAmount: "150000",
    };
    const text = withdrawalReturnText(residue);
    expect(text).toContain("0.15 $CASH");
    expect(text).toContain("came back to your balance");
  });

  it("says a below-floor residue is left behind, honestly, with what was seen", () => {
    const leftBehind: WithdrawalReturnView = {
      ...base,
      reason: "residue",
      phase: "left-below-floor",
      nativeSeen: "50000000",
    };
    const text = withdrawalReturnText(leftBehind);
    expect(text).toContain("cost more");
    expect(text).toContain("DOT");
  });

  it("still says something sensible when the amount fields are unusable", () => {
    const text = withdrawalReturnText({
      ...base,
      reason: "residue",
      returned: true,
      returnedAmount: "not-a-number",
    });
    expect(text).toContain("came back to your balance");
    expect(text).not.toContain("NaN");
  });
});
