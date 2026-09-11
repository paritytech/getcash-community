// The Fees and Total rows a top-up's quote produces, shared by the journey and the settled
// receipt. Both screens read the same quote — the live one while a request is on screen, the
// list's stored copy otherwise — and must present it identically.

import { fmtFiat, isMoneyAmount } from "../utils/money";

export interface QuoteView {
  amount: string;
  symbol: string;
  fee?: string | null;
  /** Crypto keeps its full-precision ticker form; the fiat rails read symbol-first. */
  crypto: boolean;
  /** Only the live quote carries the split the fee drill-in needs. */
  live: boolean;
}

export interface QuoteRow {
  label: string;
  value: string;
  /** The value drills into the fee breakdown. */
  fees?: boolean;
}

export function quoteDetailRows(quote: QuoteView | null): QuoteRow[] {
  if (quote === null) return [];
  const money = (amount: string) =>
    quote.crypto ? `${amount} ${quote.symbol}` : fmtFiat(amount, quote.symbol);
  const rows: QuoteRow[] = [];
  // The fee row drills into the breakdown screen only when the live quote backs it with a fee the
  // breakdown can actually split; an unparseable one, or a stored one, still shows as plain text.
  if (quote.fee) {
    rows.push({
      label: "Fees",
      value: money(quote.fee),
      fees: quote.live && isMoneyAmount(quote.fee),
    });
  }
  rows.push({ label: "Total", value: money(quote.amount) });
  return rows;
}
