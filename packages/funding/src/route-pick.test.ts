// Route picking over scripted provider answers: what wins, what is reported when nothing does, and
// which routes are asked at all.

import { describe, expect, it } from "vitest";
import type { ConversionRoute } from "./route";
import { pickRoute, type RouteAnswer, type RoutePick } from "./route-pick";

const PSM: ConversionRoute = { tier: "psm", external: "USDT", feeRate: 5_000 };
const POOL: ConversionRoute = { tier: "pool" };
const POOL_FED_USDT: ConversionRoute = { tier: "pool", external: "USDT" };
const ROUTES: ConversionRoute[] = [PSM, POOL, POOL_FED_USDT];

const accepted = (value: string): RouteAnswer<string> => ({ kind: "accepted", value });
const tooSmall = (minimumCash: bigint): RouteAnswer<string> => ({ kind: "too-small", minimumCash });
const refused = (reason: string): RouteAnswer<string> => ({ kind: "refused", reason });
const outage = (reason: string): RouteAnswer<string> => ({ kind: "outage", reason });

describe("pickRoute", () => {
  // `answers[i]` is the provider's answer about `ROUTES[i]`; `asked` is how many routes were asked.
  it.each<[string, RouteAnswer<string>[], RoutePick<string>, number]>([
    [
      "the first accepted wins",
      [accepted("a"), accepted("b"), accepted("c")],
      { kind: "picked", route: PSM, value: "a" },
      1,
    ],
    [
      "too small, then accepted",
      [tooSmall(20n), accepted("b"), accepted("c")],
      { kind: "picked", route: POOL, value: "b" },
      2,
    ],
    [
      "refused, then accepted",
      [refused("no pair"), accepted("b"), accepted("c")],
      { kind: "picked", route: POOL, value: "b" },
      2,
    ],
    [
      "an outage stops the walk",
      [outage("down"), accepted("b"), accepted("c")],
      { kind: "outage", reason: "down" },
      1,
    ],
    [
      "too small, then an outage",
      [tooSmall(20n), outage("down"), accepted("c")],
      { kind: "outage", reason: "down" },
      2,
    ],
    [
      "all too small gives the smallest minimum",
      [tooSmall(20n), tooSmall(4n), tooSmall(9n)],
      { kind: "too-small", minimumCash: 4n },
      3,
    ],
    [
      "too small outranks a refusal",
      [refused("no pair"), tooSmall(4n), refused("no route")],
      { kind: "too-small", minimumCash: 4n },
      3,
    ],
    [
      "all refused gives the first reason",
      [refused("no pair"), refused("no route"), refused("closed")],
      { kind: "refused", reason: "no pair" },
      3,
    ],
  ])("%s", async (_, answers, expected, asked) => {
    const seen: ConversionRoute[] = [];
    const pick = await pickRoute(ROUTES, async (route) => {
      seen.push(route);
      return answers[ROUTES.indexOf(route)]!;
    });
    expect(pick).toEqual(expected);
    expect(seen).toEqual(ROUTES.slice(0, asked));
  });

  it("throws on an empty list", async () => {
    await expect(pickRoute([], async () => accepted("a"))).rejects.toThrow(/at least one route/);
  });
});
