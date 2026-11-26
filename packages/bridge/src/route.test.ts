// The bridge route choice over scripted answers: which route is asked first, when the other one
// is asked, how often a silent route is asked again, and what is reported when neither is open.

import { describe, expect, it } from "vitest";
import {
  bridgeRouteOrder,
  chooseBridgeRoute,
  DEFAULT_BRIDGE_THRESHOLD,
  type BridgeAnswer,
  type BridgeChoice,
  type BridgeRoute,
} from "./route";

const CASH = 1_000_000n;
const SMALL = 50n * CASH;
const LARGE = 500n * CASH;

const open = (value: string): BridgeAnswer<string> => ({ kind: "open", value });
const closed = (reason: string): BridgeAnswer<string> => ({ kind: "closed", reason });
const tooSmall = (minimumCash: bigint): BridgeAnswer<string> => ({
  kind: "too-small",
  minimumCash,
});
const silentRoute = (reason: string): BridgeAnswer<string> => ({
  kind: "no-answer",
  from: "route",
  reason,
});
const silentProvider = (reason: string): BridgeAnswer<string> => ({
  kind: "no-answer",
  from: "provider",
  reason,
});

type Script = Partial<Record<BridgeRoute, BridgeAnswer<string>[]>>;

/** Runs the choice over `script`, each route answering its list in order, and returns the choice,
 *  the routes asked and how often the walk paused. A route asked past the end of its list fails
 *  the test. */
async function run(
  amountCash: bigint,
  script: Script,
  options: { tries?: number; threshold?: bigint } = {},
): Promise<{ choice: BridgeChoice<string>; asked: BridgeRoute[]; pauses: number }> {
  const asked: BridgeRoute[] = [];
  let pauses = 0;
  const left: Script = {
    base: [...(script.base ?? [])],
    snowbridge: [...(script.snowbridge ?? [])],
  };
  const choice = await chooseBridgeRoute<string>({
    amountCash,
    ...options,
    ask: async (route) => {
      asked.push(route);
      const answer = left[route]?.shift();
      if (answer === undefined) throw new Error(`${route} was asked once too often`);
      return answer;
    },
    pause: async () => {
      pauses += 1;
    },
  });
  return { choice, asked, pauses };
}

describe("bridgeRouteOrder", () => {
  it("asks Base first under the threshold and Snowbridge first from it", () => {
    expect(bridgeRouteOrder(DEFAULT_BRIDGE_THRESHOLD - 1n)).toEqual(["base", "snowbridge"]);
    expect(bridgeRouteOrder(DEFAULT_BRIDGE_THRESHOLD)).toEqual(["snowbridge", "base"]);
    expect(bridgeRouteOrder(0n)).toEqual(["base", "snowbridge"]);
  });

  it("sets the threshold at 200 CASH unless told otherwise", () => {
    expect(DEFAULT_BRIDGE_THRESHOLD).toBe(200n * CASH);
    expect(bridgeRouteOrder(150n * CASH, 100n * CASH)).toEqual(["snowbridge", "base"]);
    expect(bridgeRouteOrder(99n * CASH, 100n * CASH)).toEqual(["base", "snowbridge"]);
  });
});

describe("chooseBridgeRoute, a small amount", () => {
  it("takes Base when it is open and does not ask Snowbridge", async () => {
    const { choice, asked, pauses } = await run(SMALL, { base: [open("b")] });
    expect(choice).toEqual({ kind: "picked", route: "base", value: "b", declined: [] });
    expect(asked).toEqual(["base"]);
    expect(pauses).toBe(0);
  });

  it("goes to Snowbridge at once when Base is closed", async () => {
    const { choice, asked, pauses } = await run(SMALL, {
      base: [closed("the vault is full")],
      snowbridge: [open("s")],
    });
    expect(choice).toEqual({
      kind: "picked",
      route: "snowbridge",
      value: "s",
      declined: [{ route: "base", decline: { kind: "closed", reason: "the vault is full" } }],
    });
    expect(asked).toEqual(["base", "snowbridge"]);
    expect(pauses).toBe(0);
  });

  it("goes to Snowbridge at once when the amount is under Base's minimum", async () => {
    const { choice, asked } = await run(SMALL, {
      base: [tooSmall(60n * CASH)],
      snowbridge: [open("s")],
    });
    expect(choice).toMatchObject({ kind: "picked", route: "snowbridge" });
    expect(choice.declined).toEqual([
      { route: "base", decline: { kind: "too-small", minimumCash: 60n * CASH } },
    ]);
    expect(asked).toEqual(["base", "snowbridge"]);
  });

  it("reports both routes, in the order asked, when neither is open", async () => {
    const { choice, asked } = await run(SMALL, {
      base: [closed("deposits are paused")],
      snowbridge: [closed("the gateway is paused")],
    });
    expect(choice).toEqual({
      kind: "unavailable",
      declined: [
        { route: "base", decline: { kind: "closed", reason: "deposits are paused" } },
        { route: "snowbridge", decline: { kind: "closed", reason: "the gateway is paused" } },
      ],
    });
    expect(asked).toEqual(["base", "snowbridge"]);
  });
});

describe("chooseBridgeRoute, a large amount", () => {
  it("takes Snowbridge when it is open and does not ask Base", async () => {
    const { choice, asked } = await run(LARGE, { snowbridge: [open("s")] });
    expect(choice).toEqual({ kind: "picked", route: "snowbridge", value: "s", declined: [] });
    expect(asked).toEqual(["snowbridge"]);
  });

  it("goes to Base at once, with no second try, when Snowbridge is closed", async () => {
    const { choice, asked, pauses } = await run(LARGE, {
      snowbridge: [closed("the gateway is paused")],
      base: [open("b")],
    });
    expect(choice).toMatchObject({ kind: "picked", route: "base", value: "b" });
    expect(asked).toEqual(["snowbridge", "base"]);
    expect(pauses).toBe(0);
  });

  it("is not available when Snowbridge is closed and Base has no room for it", async () => {
    const { choice, asked } = await run(LARGE, {
      snowbridge: [closed("the swap loses too much")],
      base: [closed("no room for this amount")],
    });
    expect(choice.kind).toBe("unavailable");
    expect(choice.declined.map((entry) => entry.route)).toEqual(["snowbridge", "base"]);
    expect(asked).toEqual(["snowbridge", "base"]);
  });
});

describe("chooseBridgeRoute, a route that gives no answer", () => {
  it("asks the route three times, then goes to the other one", async () => {
    const { choice, asked, pauses } = await run(LARGE, {
      snowbridge: [silentRoute("read failed"), silentRoute("read failed"), silentRoute("timeout")],
      base: [open("b")],
    });
    expect(choice).toEqual({
      kind: "picked",
      route: "base",
      value: "b",
      declined: [
        { route: "snowbridge", decline: { kind: "no-answer", from: "route", reason: "timeout" } },
      ],
    });
    expect(asked).toEqual(["snowbridge", "snowbridge", "snowbridge", "base"]);
    expect(pauses).toBe(2);
  });

  it("takes the route when a later try answers", async () => {
    const { choice, asked, pauses } = await run(LARGE, {
      snowbridge: [silentRoute("read failed"), open("s")],
    });
    expect(choice).toEqual({ kind: "picked", route: "snowbridge", value: "s", declined: [] });
    expect(asked).toEqual(["snowbridge", "snowbridge"]);
    expect(pauses).toBe(1);
  });

  it("stops asking again once the route says it is closed", async () => {
    const { choice, asked, pauses } = await run(LARGE, {
      snowbridge: [silentRoute("read failed"), closed("the gateway is paused")],
      base: [open("b")],
    });
    expect(choice).toMatchObject({ kind: "picked", route: "base" });
    expect(asked).toEqual(["snowbridge", "snowbridge", "base"]);
    expect(pauses).toBe(1);
  });

  it("gives the second route its own three tries", async () => {
    const { choice, asked, pauses } = await run(SMALL, {
      base: [silentRoute("a"), silentRoute("b"), silentRoute("c")],
      snowbridge: [silentRoute("d"), silentRoute("e"), open("s")],
    });
    expect(choice).toMatchObject({ kind: "picked", route: "snowbridge", value: "s" });
    expect(asked).toEqual(["base", "base", "base", "snowbridge", "snowbridge", "snowbridge"]);
    expect(pauses).toBe(4);
  });

  it("asks once, with no pause, when told to try once", async () => {
    const { choice, asked, pauses } = await run(
      LARGE,
      { snowbridge: [silentRoute("read failed")], base: [open("b")] },
      { tries: 1 },
    );
    expect(choice).toMatchObject({ kind: "picked", route: "base" });
    expect(asked).toEqual(["snowbridge", "base"]);
    expect(pauses).toBe(0);
  });

  it("asks once when the number of tries is zero or less", async () => {
    const { asked } = await run(
      LARGE,
      { snowbridge: [silentRoute("read failed")], base: [open("b")] },
      { tries: 0 },
    );
    expect(asked).toEqual(["snowbridge", "base"]);
  });
});

describe("chooseBridgeRoute, a provider that gives no answer", () => {
  it("asks three times, then stops without asking the other route", async () => {
    const { choice, asked, pauses } = await run(LARGE, {
      snowbridge: [silentProvider("no quote"), silentProvider("no quote"), silentProvider("slow")],
      base: [open("b")],
    });
    expect(choice).toEqual({
      kind: "unavailable",
      declined: [
        { route: "snowbridge", decline: { kind: "no-answer", from: "provider", reason: "slow" } },
      ],
    });
    expect(asked).toEqual(["snowbridge", "snowbridge", "snowbridge"]);
    expect(pauses).toBe(2);
  });

  it("stops for a small amount too", async () => {
    const { choice, asked } = await run(SMALL, {
      base: [silentProvider("x"), silentProvider("y"), silentProvider("z")],
      snowbridge: [open("s")],
    });
    expect(choice.kind).toBe("unavailable");
    expect(asked).toEqual(["base", "base", "base"]);
  });

  it("takes the route when the provider answers on a later try", async () => {
    const { choice, asked } = await run(SMALL, {
      base: [silentProvider("no quote"), silentProvider("no quote"), open("b")],
    });
    expect(choice).toEqual({ kind: "picked", route: "base", value: "b", declined: [] });
    expect(asked).toEqual(["base", "base", "base"]);
  });

  it("lets the last answer decide: the route's own silence goes to the other route", async () => {
    const { choice, asked } = await run(LARGE, {
      snowbridge: [silentProvider("no quote"), silentProvider("no quote"), silentRoute("read")],
      base: [open("b")],
    });
    expect(choice).toMatchObject({ kind: "picked", route: "base" });
    expect(asked).toEqual(["snowbridge", "snowbridge", "snowbridge", "base"]);
  });

  it("lets the last answer decide: the provider's silence stops the walk", async () => {
    const { choice, asked } = await run(LARGE, {
      snowbridge: [silentRoute("read"), silentRoute("read"), silentProvider("no quote")],
      base: [open("b")],
    });
    expect(choice.kind).toBe("unavailable");
    expect(asked).toEqual(["snowbridge", "snowbridge", "snowbridge"]);
  });

  it("stops at the second route too, after the first one was closed", async () => {
    const { choice, asked } = await run(SMALL, {
      base: [closed("the vault is full")],
      snowbridge: [silentProvider("a"), silentProvider("b"), silentProvider("c")],
    });
    expect(choice.kind).toBe("unavailable");
    expect(choice.declined.map((entry) => entry.decline.kind)).toEqual(["closed", "no-answer"]);
    expect(asked).toEqual(["base", "snowbridge", "snowbridge", "snowbridge"]);
  });
});

describe("chooseBridgeRoute, the other inputs", () => {
  it("uses the threshold it is given", async () => {
    const { asked } = await run(
      150n * CASH,
      { snowbridge: [open("s")] },
      { threshold: 100n * CASH },
    );
    expect(asked).toEqual(["snowbridge"]);
  });

  it("does not need a pause", async () => {
    const answers = [silentRoute("read failed"), open("s")];
    const choice = await chooseBridgeRoute<string>({
      amountCash: LARGE,
      ask: async () => answers.shift() ?? closed("nothing left"),
    });
    expect(choice).toMatchObject({ kind: "picked", route: "snowbridge", value: "s" });
  });

  it("does not catch an error thrown while asking", async () => {
    await expect(
      chooseBridgeRoute<string>({
        amountCash: SMALL,
        ask: async () => {
          throw new Error("broken");
        },
      }),
    ).rejects.toThrow("broken");
  });
});
