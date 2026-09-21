// The rows a top-up's quote produces, shared by the journey and the settled receipt. Both screens
// read the same quote — the live one while a request is on screen, the list's stored copy
// otherwise — and must present it identically.

import { shortRef } from "../utils/journey";
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
  /** The full text a copy control puts on the clipboard; `value` may be an elided form of it. */
  copy?: string;
}

/**
 * What the buyer paid, as the one row both screens lead with.
 *
 * A separate Fees row restated part of the number sitting right beside it; the total already
 * contains the fee, so the label says so and the chevron carries the split. The drill-in is only
 * offered while the quote is live, because only a live quote carries the split the breakdown
 * reads; an unparseable fee, or a stored one, leaves the row as plain text.
 */
function paidRow(quote: QuoteView): QuoteRow {
  // Symbol-first for the fiat rails ("€50.55"); crypto keeps its full-precision ticker form.
  const value = quote.crypto
    ? `${quote.amount} ${quote.symbol}`
    : fmtFiat(quote.amount, quote.symbol);
  return {
    label: quote.fee ? "You paid inc. fees" : "You paid",
    value,
    fees: quote.live && isMoneyAmount(quote.fee ?? ""),
  };
}

export function quoteDetailRows(quote: QuoteView | null): QuoteRow[] {
  return quote === null ? [] : [paidRow(quote)];
}

/**
 * The rows a concluded fiat top-up shows instead of the live quote's own.
 *
 * Both rails end up here. A card payment that was refunded still charged the buyer, and the two
 * figures differ — the ribbon says what came back, this says what went out — so the design keeps
 * the money row on a refund rather than dropping it with the quote. The provider and the
 * reference ride with it: between them they are what a buyer hands support. The reference is the
 * funding request's own id, the only identifier the adapter surfaces — the rail's is held back
 * behind its DTO.
 */
export function paidDetailRows(
  quote: QuoteView | null,
  paid: { provider?: string; reference?: string; network?: string } = {},
): QuoteRow[] {
  const rows: QuoteRow[] = [];
  // Fiat only. The crypto rail's deposit figure belongs to the deposit screen, and restating it
  // against a refund reads as a second charge rather than the one sum that went out and came back.
  if (quote !== null && !quote.crypto) rows.push(paidRow(quote));
  if (paid.network) rows.push({ label: "Network", value: paid.network });
  if (paid.provider) rows.push({ label: "Provider", value: paid.provider });
  if (paid.reference) {
    rows.push({
      label: "Transaction ID",
      value: shortRef(paid.reference),
      copy: paid.reference,
    });
  }
  return rows;
}
