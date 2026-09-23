// The quote a top-up's screens read, and the CASH it buys.
//
// One rule for both: the live quote while a request is on screen, the list's stored copy
// otherwise. The money row and the fee breakdown behind its chevron are separate screens reading
// the same numbers, so they resolve them the same way or they disagree — a row that offers a
// drill-in onto an empty page is worse than no row at all.

import { computed, type ComputedRef } from "vue";
import { liveQuoteView, storedQuoteView, type QuoteView } from "../funding/quote-rows";
import type { FundingTopUp } from "../funding/top-ups";
import { useSessionStore } from "../stores/session";

export interface JourneyQuote {
  quote: ComputedRef<QuoteView | null>;
  /** The CASH the quote buys, for the breakdown's rate line. */
  cashAmount: ComputedRef<string>;
}

export function useJourneyQuote(
  topUp: () => FundingTopUp | null | undefined,
  /**
   * A record read from the list, with no request on screen behind it. Its own stored quote is then
   * the only truth there is: the session's belongs to whatever top-up is actually live, and reading
   * that one would put another top-up's numbers behind this one's money row.
   */
  readOnly: () => boolean = () => false,
): JourneyQuote {
  const session = useSessionStore();
  return {
    quote: computed(() => {
      const row = topUp();
      if (!readOnly()) {
        const live = session.quoted;
        if (live) return liveQuoteView(live, session.method === "crypto");
      }
      return storedQuoteView(row?.quote, row?.route === "crypto");
    }),
    // The store's amount is empty until the request is live; the list's word on it fills in.
    cashAmount: computed(() =>
      readOnly() ? (topUp()?.amount ?? "") : session.amountHuman || (topUp()?.amount ?? ""),
    ),
  };
}
