// What another product hands the withdrawal when it opens getcash to send money out. A merchant
// terminal calls the host's `navigateTo("polkadot://<getcash>/#/withdraw?amount=120.5&route=bank")`
// to cash out the day's sales: the page lands on the amount screen with that amount and route
// already chosen, and the user still confirms every step. Nothing is spent on the hand-off's word.
//
// The host keeps the deep link's fragment, so the parameters arrive as the hash route's query.
// The page's own search is read too, for a host that delivers them there.

import { canonicalizeFundingAmount, isFundingRoute, type FundingRoute } from "../funding/selection";

export type WithdrawHandoff = Readonly<{
  /** Canonical amount in CASH at the keypad's scale; null when none or unreadable. */
  amount: string | null;
  route: FundingRoute | null;
}>;

/** Reads `amount` and `route`. An amount finer than the keypad's scale, or not a number, is
 *  dropped rather than rounded: the user types it instead. The amount is not checked against the
 *  bounds or the purse here; the amount screen does that, in its own words. */
export function readWithdrawHandoff(
  params: URLSearchParams,
  decimals: number,
): WithdrawHandoff | null {
  const rawAmount = params.get("amount");
  const rawRoute = params.get("route");
  const canonical = rawAmount === null ? null : canonicalizeFundingAmount(rawAmount, decimals);
  const amount = canonical === "0" ? null : canonical;
  const route = rawRoute !== null && isFundingRoute(rawRoute) ? rawRoute : null;
  if (amount === null && route === null) return null;
  return { amount, route };
}

/** The hand-off's parameters, the hash route's query over the page's own search. */
export function withdrawHandoffParams(
  search: string,
  routeQuery: Readonly<Record<string, unknown>>,
): URLSearchParams {
  const params = new URLSearchParams(search);
  for (const key of ["amount", "route"]) {
    const value = routeQuery[key];
    if (typeof value === "string") params.set(key, value);
  }
  return params;
}
