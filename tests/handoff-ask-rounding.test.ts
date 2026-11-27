// The hand-off of a native direct deposit records what rounding its ask up added, so the page's
// gate stays where the unrounded ask put it. No other deposit's hand-off carries it. Every direct
// deposit's hand-off is marked for a claim held to its target, and no other top-up's is.

import { describe, expect, it } from "vitest";
import type { SourceId } from "@getsome/core";
import type { ConversionRoute } from "@getsome/funding";
import { createMockCoinageSession } from "../lib/coinage";

describe("mock world: what rounding added to the ask, and the claim's mark", () => {
  it.each<[string, SourceId, ConversionRoute, bigint, string | undefined, true | undefined]>([
    [
      "a DOT deposit off its second decimal",
      "dot-assethub",
      { tier: "pool" },
      23_456_789_012n,
      "43210988",
      true,
    ],
    [
      "a DOT deposit already on it",
      "dot-assethub",
      { tier: "pool" },
      23_500_000_000n,
      undefined,
      true,
    ],
    [
      "a stable deposit",
      "usdc-assethub",
      { tier: "pool", external: "USDC" },
      12_345_678n,
      undefined,
      true,
    ],
    [
      "a card top-up delivered in DOT",
      "meld-card",
      { tier: "pool" },
      23_456_789_012n,
      undefined,
      undefined,
    ],
  ])("%s", async (_name, sourceId, route, nativeBudget, added, exactClaim) => {
    const world = await createMockCoinageSession({
      recipient: "5Burner",
      amount: 10_000_000n,
      sourceId,
      route,
      nativeBudget,
    });
    const handoff = await world.handoffPayload();
    expect(handoff.askRoundingNative).toBe(added);
    expect(handoff.exactClaim).toBe(exactClaim);
    world.session.dispose();
  });
});
