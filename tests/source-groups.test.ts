// The token picker's grouping and the line under a greyed row.

import { describe, expect, it } from "vitest";
import { groupTokens, tokenSubtitle, wholeCashCeil } from "../app/funding/source-groups";
import type { TokenOffer, TokenRow } from "../app/stores/offers";

const token = (asset: string, offer: TokenOffer): TokenRow => ({
  asset,
  sourceId: asset.toLowerCase() as TokenRow["sourceId"],
  offer,
});

describe("source groups", () => {
  it("rounds a minimum up to whole CASH", () => {
    expect(wholeCashCeil(80_000_000n)).toBe("80");
    expect(wholeCashCeil(80_000_001n)).toBe("81");
  });

  it("says why a token cannot be picked, and nothing when it can", () => {
    expect(tokenSubtitle({ state: "too-small", minimumCashBase: 80_000_000n })).toBe(
      "Minimum for this token is $80 CASH",
    );
    expect(tokenSubtitle({ state: "too-small", minimumCashBase: null })).toBe("Amount too small");
    expect(tokenSubtitle({ state: "rail-off" })).toBe("Not available yet");
    expect(tokenSubtitle({ state: "unavailable", reason: "maintenance" })).toBe(
      "Not available right now",
    );
    expect(tokenSubtitle({ state: "ungated" })).toBeUndefined();
    // Never drawn as a row: the picker shows a skeleton row in its place.
    expect(tokenSubtitle({ state: "checking" })).toBeUndefined();
  });

  it("groups tokens the same way", () => {
    const usdt = token("USDT", { state: "ungated" });
    const usdc = token("USDC", { state: "unavailable", reason: "down" });
    expect(groupTokens([usdc, usdt])).toEqual([
      { label: "All tokens", rows: [usdt] },
      { label: "Unsupported token", rows: [usdc] },
    ]);
  });
});
