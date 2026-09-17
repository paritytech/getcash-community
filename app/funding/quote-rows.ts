// The Fees and Total rows a top-up's quote produces, shared by the journey and the settled
// receipt. Both screens read the same quote — the live one while a request is on screen, the
// list's stored copy otherwise — and must present it identically.

import { shortAddress } from "../utils/address";
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

/**
 * The rows a concluded fiat top-up shows instead of the live quote's Fees and Total.
 *
 * Both rails end up here. A card payment that was refunded still charged the buyer, and the two
 * figures differ — the
 * ribbon says what came back, this says what went out — so the design keeps the money row on a
 * refund rather than dropping it with the quote. The provider and the reference ride with it:
 * between them they are what a buyer hands support. The reference is the funding request's own id,
 * the only identifier the adapter surfaces — the rail's is held back behind its DTO.
 */
export function paidDetailRows(
  quote: QuoteView | null,
  paid: { provider?: string; reference?: string; network?: string } = {},
): QuoteRow[] {
  const rows: QuoteRow[] = [];
  // Fiat only. The crypto rail's deposit figure belongs to the deposit screen, and restating it
  // against a refund reads as a second charge rather than the one sum that went out and came back.
  if (quote !== null && !quote.crypto) {
    rows.push({
      label: "You paid inc. fees",
      value: fmtFiat(quote.amount, quote.symbol),
      fees: quote.live && isMoneyAmount(quote.fee ?? ""),
    });
  }
  if (paid.network) rows.push({ label: "Network", value: paid.network });
  if (paid.provider) rows.push({ label: "Provider", value: paid.provider });
  if (paid.reference) {
    rows.push({
      label: "Transaction ID",
      value: shortAddress(paid.reference),
      copy: paid.reference,
    });
  }
  return rows;
}
