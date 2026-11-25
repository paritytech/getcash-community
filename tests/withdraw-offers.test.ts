import { describe, expect, it } from "vitest";
import type { ConversionRoute } from "@getsome/funding";
import { sameSale } from "../app/withdraw/offers";

describe("whether the sale at confirm is the one the summary showed", () => {
  const PSM: ConversionRoute = { tier: "psm", external: "USDT", feeRate: 5_000 };
  it.each<[string, ConversionRoute, ConversionRoute, boolean]>([
    ["the same PSM sale", PSM, { ...PSM }, true],
    ["the PSM at another fee rate", PSM, { ...PSM, feeRate: 6_000 }, false],
    ["the PSM against the pool", PSM, { tier: "pool" }, false],
    ["the pool for the native", { tier: "pool" }, { tier: "pool" }, true],
    ["the pool fed through a stable", { tier: "pool" }, { tier: "pool", external: "USDT" }, false],
    ["dotUSD", { tier: "dotusd" }, { tier: "dotusd" }, true],
  ])("%s", (_, shown, fresh, same) => {
    expect(sameSale(shown, fresh)).toBe(same);
    expect(sameSale(fresh, shown)).toBe(same);
  });
});
