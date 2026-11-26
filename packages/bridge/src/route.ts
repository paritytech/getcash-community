// Choosing the bridge route of a top-up. Base is asked first for a small amount and Snowbridge
// for a large one, and each is the other's fallback. The choice is made once, when the request
// is quoted.

/** The two bridge routes. */
export type BridgeRoute = "base" | "snowbridge";

/** The amount from which Snowbridge is asked first, in CASH base units: 200 CASH. */
export const DEFAULT_BRIDGE_THRESHOLD = 200_000_000n;

/** How many times a route is asked while it gives no answer. */
export const DEFAULT_BRIDGE_TRIES = 3;

/** Why a route cannot take an amount. */
export type BridgeDecline =
  /** A lasting state: the route is paused, has no room, or would lose too much. */
  | { kind: "closed"; reason: string }
  /** The amount is under the route's minimum, in CASH base units. */
  | { kind: "too-small"; minimumCash: bigint }
  /** Nothing came back. `from` names what stayed silent: the route's own reads, or the provider
   *  that both routes ask. */
  | { kind: "no-answer"; from: "route" | "provider"; reason: string };

/** What asking a route about an amount answers: open, with what its checks returned, or why not. */
export type BridgeAnswer<T> = { kind: "open"; value: T } | BridgeDecline;

/** A route that was asked and could not take the amount. */
export interface DeclinedRoute {
  route: BridgeRoute;
  decline: BridgeDecline;
}

/** The route taken with what its checks returned, or none. `declined` lists the routes that were
 *  asked and could not take the amount, in the order asked. */
export type BridgeChoice<T> =
  | { kind: "picked"; route: BridgeRoute; value: T; declined: DeclinedRoute[] }
  | { kind: "unavailable"; declined: DeclinedRoute[] };

export interface BridgeChoiceInput<T> {
  /** The top-up, in CASH base units. */
  amountCash: bigint;
  /** Asks one route about the amount. Errors it throws are not caught here. */
  ask: (route: BridgeRoute) => Promise<BridgeAnswer<T>>;
  /** The amount from which Snowbridge is asked first. */
  threshold?: bigint;
  /** How many times a route is asked while it gives no answer. It is always asked once. */
  tries?: number;
  /** Waits between two tries of the same route. */
  pause?: () => Promise<void>;
}

/** The order the routes are asked in: Base first under the threshold, Snowbridge first from it. */
export function bridgeRouteOrder(
  amountCash: bigint,
  threshold: bigint = DEFAULT_BRIDGE_THRESHOLD,
): [BridgeRoute, BridgeRoute] {
  return amountCash < threshold ? ["base", "snowbridge"] : ["snowbridge", "base"];
}

/**
 * Asks the routes in order and takes the first that is open. A route that is closed or has a
 * higher minimum moves on to the next one at once; a silent one is asked again up to `tries`
 * times, and then its own silence moves on while the provider's ends the walk, since the next
 * route asks it too.
 */
export async function chooseBridgeRoute<T>(input: BridgeChoiceInput<T>): Promise<BridgeChoice<T>> {
  const tries = input.tries ?? DEFAULT_BRIDGE_TRIES;
  const declined: DeclinedRoute[] = [];
  for (const route of bridgeRouteOrder(input.amountCash, input.threshold)) {
    let answer = await input.ask(route);
    for (let asked = 1; answer.kind === "no-answer" && asked < tries; asked++) {
      await input.pause?.();
      answer = await input.ask(route);
    }
    if (answer.kind === "open") return { kind: "picked", route, value: answer.value, declined };
    declined.push({ route, decline: answer });
    if (answer.kind === "no-answer" && answer.from === "provider") break;
  }
  return { kind: "unavailable", declined };
}
