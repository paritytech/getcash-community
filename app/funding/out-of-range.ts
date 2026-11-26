// The out-of-range screen's words: an amount a quote refused for falling outside a bound, the
// bound it missed, and the amount in CASH that would meet it, worded by the method and the region.

import type { DetailRow } from "../components/ui/DetailRows.vue";
import type { QuoteOutOfRange } from "../stores/session";
import { cashAmount } from "../utils/cash";
import { fmtFiat } from "../utils/money";

export interface OutOfRangeWords {
  /** The red line under the amount. */
  message: string;
  /** The bound, as a row. */
  rows: DetailRow[];
  /** The amount in CASH that meets the bound; null when it could not be scaled, which leaves a
   *  change of amount as the only way on. */
  bound: string | null;
}

/** A card or bank top-up whose amount costs less than the method's minimum or more than its
 *  maximum in the region: the bound in CASH, or in the region's fiat when it could not be scaled. */
export function fiatOutOfRange(
  range: QuoteOutOfRange,
  method: "card" | "bank",
  countryName: string,
): OutOfRangeWords {
  const payment = method === "bank" ? "bank payment" : "card payment";
  const below = range.bound === "min";
  const label = below ? "Min. payment" : "Max. payment";
  if (range.cash === null) {
    return {
      message: `${below ? "Below the minimum" : "Above the maximum"} for ${payment} in ${countryName}`,
      rows: [{ label, value: fmtFiat(range.limit, range.fiat) }],
      bound: null,
    };
  }
  return {
    message: below
      ? `You need at least ${cashAmount(range.cash)} for ${payment} in ${countryName}`
      : `You can pay at most ${cashAmount(range.cash)} by ${payment} in ${countryName}`,
    rows: [{ label, value: cashAmount(range.cash) }],
    bound: range.cash,
  };
}

/** A card or bank top-up whose amount the provider turned down without naming a bound: no row and
 *  no bound, so a different amount is the one way on. */
export function fiatAmountRejected(method: "card" | "bank", countryName: string): OutOfRangeWords {
  const payment = method === "bank" ? "bank payment" : "card payment";
  return {
    message: `This amount can't be paid by ${payment} in ${countryName}`,
    rows: [],
    bound: null,
  };
}
