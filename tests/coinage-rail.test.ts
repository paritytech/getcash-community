// Which rail a direct deposit runs on in the live world: the manual rail for the route's token.

import { describe, expect, it } from "vitest";
import type { ConversionRoute } from "@getsome/funding";
import { railFor } from "../lib/coinage";

const POOL: ConversionRoute = { tier: "pool" };
const PSM: ConversionRoute = { tier: "psm", external: "USDT", feeRate: 0 };

describe("railFor", () => {
  it("runs on the manual rail for the route's token", () => {
    expect(railFor(PSM).sources()[0]?.sourceId).toBe("usdt-assethub");
    expect(railFor(POOL).sources()[0]?.sourceId).toBe("dot-assethub");
  });
});
