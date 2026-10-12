// The ending rules the journey reads: whether a top-up expired, and the amount its header shows.

import { describe, expect, it } from "vitest";
import { headerAmount, isExpiredEnding } from "../app/funding/journey-endings";
import { DEPOSIT_EXPIRED_REASON } from "../app/funding/requests/model";

describe("journey endings", () => {
  it("names an expired top-up from its own failure", () => {
    expect(isExpiredEnding("expired", null)).toBe(true);
    expect(isExpiredEnding("stale", null)).toBe(true);
    expect(isExpiredEnding(undefined, DEPOSIT_EXPIRED_REASON)).toBe(true);
    // A named ending is not an expiry: it keeps its quote rows, which an expiry drops.
    expect(isExpiredEnding("deposit-rejected", "Top-up didn't go through.")).toBe(false);
    expect(isExpiredEnding(undefined, null)).toBe(false);
  });
});

describe("journey header amount", () => {
  it("shows the asked amount until the end, then what the Host credited", () => {
    const amounts = { asked: "50", credited: "50.12" };
    const cases: [string, Parameters<typeof headerAmount>, ReturnType<typeof headerAmount>][] = [
      ["before the end", [null, amounts], { sign: "", amount: "50" }],
      [
        "bank claim off the quote",
        [null, { ...amounts, revised: "48.2" }],
        { sign: "", amount: "48.2" },
      ],
      ["success", ["success", amounts], { sign: "+", amount: "50.12" }],
      ["success with no claim", ["success", { asked: "50" }], { sign: "+", amount: "50" }],
      [
        "bank success",
        ["success", { asked: "50", revised: "48.2", credited: "48.2" }],
        { sign: "+", amount: "48.2" },
      ],
      ["partial claim", ["failure", { asked: "50", credited: "30" }], { sign: "", amount: "30" }],
      ["failure with no credit", ["failure", { asked: "50" }], { sign: "", amount: "50" }],
    ];
    for (const [name, args, shown] of cases) expect(headerAmount(...args), name).toEqual(shown);
  });
});
