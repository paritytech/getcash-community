// The mock world hands its funding rail a reverse-quote target. `ReverseQuoteInput.target` is
// `{ amount, decimals }` with no asset field. These pin `createMockCoinageSession` to the same
// target denominations as `createCoinageSession`.

import { describe, expect, it } from "vitest";
import { createFakeRail } from "@getsome/testing";
import { CASH_DECIMALS } from "@getsome/people";
import { NATIVE_DECIMALS } from "@getsome/meld";
import { createMockCoinageSession } from "../lib/coinage";

const RECIPIENT = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const CASH = 100n * 10n ** BigInt(CASH_DECIMALS); // 100 CASH

describe("mock world: reverse-quote denomination", () => {
  it("a CASH-egress rail is quoted in CASH, as it always was", async () => {
    const rail = createFakeRail();
    const world = await createMockCoinageSession({
      recipient: RECIPIENT,
      amount: CASH,
      sourceId: "btc",
      rail,
    });
    await world.session.ready;
    await world.session.quote();

    expect(rail.stats.lastQuoteRequest?.target).toEqual({
      amount: CASH,
      decimals: CASH_DECIMALS,
    });
    world.session.dispose();
  });

  it("a native-egress rail is quoted in native base units, never the CASH number", async () => {
    // 25 DOT: what 100 CASH is worth at a rail price of 4.
    const nativeBudget = 25n * 10n ** BigInt(NATIVE_DECIMALS);
    const rail = createFakeRail();
    const world = await createMockCoinageSession({
      recipient: RECIPIENT,
      amount: CASH,
      sourceId: "meld-card",
      rail,
      nativeBudget,
    });
    await world.session.ready;
    await world.session.quote();

    const target = rail.stats.lastQuoteRequest?.target;
    expect(target).toEqual({ amount: nativeBudget, decimals: NATIVE_DECIMALS });
    // The CASH figure must not reach the rail as a quantity.
    expect(target?.amount).not.toBe(CASH);
    world.session.dispose();
  });
});
