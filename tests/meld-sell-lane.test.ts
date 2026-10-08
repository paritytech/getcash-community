// What a sale sells for the lane the off-ramp catalog names: today's Asset Hub sale, a Chainflip lane
// this build can swap into, or nothing at all.

import { describe, expect, it } from "vitest";
import { saleLaneOf } from "../app/composables/useMeldSellQuote";

describe("saleLaneOf", () => {
  it("sells PAS on Asset Hub when the method names that lane, or none", () => {
    expect(saleLaneOf(undefined)).toBeNull();
    expect(saleLaneOf({ code: "DOT_ASSETHUB", chain: "assethub" })).toBeNull();
  });

  it("swaps into a lane this build knows", () => {
    expect(saleLaneOf({ code: "USDT_SOL", chain: "solana" })?.id).toBe("usdt-solana");
  });

  it("sells nothing for another Asset Hub asset or an unknown lane", () => {
    expect(saleLaneOf({ code: "USDT_ASSETHUB", chain: "assethub" })).toBeUndefined();
    expect(saleLaneOf({ code: "USDT_TRON", chain: "tron" })).toBeUndefined();
  });
});
