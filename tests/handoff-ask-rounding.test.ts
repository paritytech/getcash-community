// The hand-off of a native direct deposit records what rounding its ask up added, so the page's
// gate stays where the unrounded ask put it. No other deposit's hand-off carries it.

import { describe, expect, it } from "vitest";
import type { SourceId } from "@getsome/core";
import type { ConversionRoute } from "@getsome/funding";
import { createMockCoinageSession } from "../lib/coinage";

describe("mock world: what rounding added to the ask", () => {
  it.each<[string, SourceId, ConversionRoute, bigint, string | undefined]>([
    [
      "a DOT deposit off its second decimal",
      "dot-assethub",
      { tier: "pool" },
      23_456_789_012n,
      "43210988",
    ],
    ["a DOT deposit already on it", "dot-assethub", { tier: "pool" }, 23_500_000_000n, undefined],
    [
      "a stable deposit",
      "usdc-assethub",
      { tier: "pool", external: "USDC" },
      12_345_678n,
      undefined,
    ],
    ["a card top-up delivered in DOT", "meld-card", { tier: "pool" }, 23_456_789_012n, undefined],
  ])("%s", async (_name, sourceId, route, nativeBudget, added) => {
    const world = await createMockCoinageSession({
      recipient: "5Burner",
      amount: 10_000_000n,
      sourceId,
      route,
      nativeBudget,
    });
    expect((await world.handoffPayload()).askRoundingNative).toBe(added);
    world.session.dispose();
  });
});
