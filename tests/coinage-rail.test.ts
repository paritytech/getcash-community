// Which rail a source runs on in the live world: the manual rail for a direct deposit or a fiat
// source, and none for a swap source.

import { describe, expect, it } from "vitest";
import type { ConversionRoute } from "@getsome/funding";
import { railFor } from "../lib/coinage";

const POOL: ConversionRoute = { tier: "pool" };
const PSM: ConversionRoute = { tier: "psm", external: "USDT", feeRate: 0 };

describe("railFor", () => {
  it("runs a direct or a fiat source on the manual rail for the route's token", () => {
    expect(railFor("usdt-assethub", PSM).sources()[0]?.sourceId).toBe("usdt-assethub");
    expect(railFor("meld-card", POOL).sources()[0]?.sourceId).toBe("dot-assethub");
  });

  it.each(["btc", "usdt-tron"] as const)("refuses the swap source %s", (sourceId) => {
    expect(() => railFor(sourceId, POOL)).toThrow(`no rail serves swap source '${sourceId}'`);
  });
});
