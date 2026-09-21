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

export function useJourneyQuote(topUp: () => FundingTopUp | null | undefined): JourneyQuote {
  const session = useSessionStore();
  return {
    quote: computed(() => {
      const live = session.quoted;
      if (live) return liveQuoteView(live, session.method === "crypto");
      const row = topUp();
      return storedQuoteView(row?.quote, row?.route === "crypto");
    }),
    // The store's amount is empty until the request is live; the list's word on it fills in.
    cashAmount: computed(() => session.amountHuman || (topUp()?.amount ?? "")),
  };
}
