// Route picking: the chain ranks the routes it could run (`rankRoutes`), a provider is asked about
// each in that order, and the first it accepts wins. Feasibility, not price: an earlier route is
// never passed over for a cheaper later one.

import type { ConversionRoute } from "./route";

/** A provider's answer about one route that it cannot run: the amount is under its minimum,
 *  expressed in CASH base units; it has no quote for that pair; or it is not answering at all. */
export type RouteDecline =
  | { kind: "too-small"; minimumCash: bigint }
  | { kind: "refused"; reason: string }
  | { kind: "outage"; reason: string };

/** A provider's answer about one route: accepted with its figure, or declined. */
export type RouteAnswer<T> = { kind: "accepted"; value: T } | RouteDecline;

/** The route picked with the provider's figure for it, or why none was. */
export type RoutePick<T> = { kind: "picked"; route: ConversionRoute; value: T } | RouteDecline;

/** Asks `ask` about each route in order, one at a time, and returns the first accepted. An outage
 *  stops the walk, since the next route goes to the same provider, and is what is returned: a
 *  later route might have accepted. Otherwise, with none accepted, the smallest minimum when any
 *  answer was too small, else the first refusal. Errors thrown by `ask` propagate. */
export async function pickRoute<T>(
  routes: readonly ConversionRoute[],
  ask: (route: ConversionRoute) => Promise<RouteAnswer<T>>,
): Promise<RoutePick<T>> {
  let smallest: Extract<RouteDecline, { kind: "too-small" }> | undefined;
  let outage: Extract<RouteDecline, { kind: "outage" }> | undefined;
  let refusal: Extract<RouteDecline, { kind: "refused" }> | undefined;
  for (const route of routes) {
    const answer = await ask(route);
    if (answer.kind === "accepted") return { kind: "picked", route, value: answer.value };
    if (answer.kind === "too-small") {
      if (smallest === undefined || answer.minimumCash < smallest.minimumCash) smallest = answer;
    } else if (answer.kind === "refused") {
      refusal ??= answer;
    } else {
      outage = answer;
      break;
    }
  }
  const decline = outage ?? smallest ?? refusal;
  if (decline === undefined) throw new Error("pickRoute needs at least one route");
  return decline;
}
