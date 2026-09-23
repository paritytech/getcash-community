// The rows a top-up's quote produces, shared by the journey and the settled receipt. Both screens
// read the same quote — the live one while a request is on screen, the list's stored copy
// otherwise — and must present it identically.

import { shortRef } from "../utils/journey";
import { fmtFiat, isMoneyAmount } from "../utils/money";

/**
 * A fee and the components behind it, named as every source of a quote names them.
 *
 * The record persists all of them, so a quote read back off the list carries the same split the
 * live one did: the breakdown a buyer opens from history is the one they agreed to, not an
 * approximation of it.
 */
export interface FeeSplit {
  fee?: string | null;
  /** The provider's own cut. */
  transactionFee?: string | null;
  /** The rail's network fee; the app's own funding leg is priced separately as `chainFee`. */
  networkFee?: string | null;
  partnerFee?: string | null;
  chainFee?: string | null;
}

export interface QuoteView extends FeeSplit {
  /** The charge, in `symbol`. */
  amount: string;
  symbol: string;
  /** Crypto keeps its full-precision ticker form; the fiat rails read symbol-first. */
  crypto: boolean;
}

const splitOf = (q: FeeSplit): FeeSplit => ({
  fee: q.fee ?? null,
  transactionFee: q.transactionFee ?? null,
  networkFee: q.networkFee ?? null,
  partnerFee: q.partnerFee ?? null,
  chainFee: q.chainFee ?? null,
});

/** The session's live quote as the rows and the breakdown read it; its charge is `send`. */
export const liveQuoteView = (
  quote: FeeSplit & { send: string; symbol: string },
  crypto: boolean,
): QuoteView => ({ amount: quote.send, symbol: quote.symbol, crypto, ...splitOf(quote) });

/** A record's stored quote, as the rows and the breakdown read it. */
export const storedQuoteView = (
  quote: (FeeSplit & { amount: string; symbol: string }) | undefined,
  crypto: boolean,
): QuoteView | null =>
  quote === undefined
    ? null
    : { amount: quote.amount, symbol: quote.symbol, crypto, ...splitOf(quote) };

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
 * contains the fee, so the label says so and the chevron carries the split. The drill-in is
 * offered wherever there is a fee the breakdown can read — a stored quote carries the same split
 * the live one did, so a journey opened from history keeps the chevron; only a fee that will not
 * parse leaves the row as plain text.
 */
function paidRow(quote: QuoteView): QuoteRow {
  // Symbol-first for the fiat rails ("€50.55"); crypto keeps its full-precision ticker form.
  const value = quote.crypto
    ? `${quote.amount} ${quote.symbol}`
    : fmtFiat(quote.amount, quote.symbol);
  return {
    label: quote.fee ? "You paid inc. fees" : "You paid",
    value,
    fees: isMoneyAmount(quote.fee ?? ""),
  };
}

export function quoteDetailRows(quote: QuoteView | null): QuoteRow[] {
  return quote === null ? [] : [paidRow(quote)];
}

/** Which set of money rows a journey shows: the quote it is running against, the receipt for what
 *  was actually paid, or neither. */
export type JourneyMoneyRows = "quote" | "receipt" | "none";

/**
 * Which money rows the journey shows for an ending.
 *
 * The design draws three cases. A top-up still running, or one that simply landed, shows the
 * charge and nothing else — a buyer with their CASH has nobody to chase, so the settled frames
 * carry no provider or reference row. A fiat top-up that failed gets the receipt instead: the
 * charge, who took it, and the id to quote them. An expired one shows nothing, because nobody was
 * ever charged.
 *
 * The crypto rail keeps its deposit figure on the deposit screen, which owns it, so it shows no
 * money rows at all — except on a refund, where the receipt names the network and the rail that
 * handled it and the guide tells the money's own story.
 */
export function journeyMoneyRows(ending: {
  crypto: boolean;
  expired: boolean;
  failed: boolean;
  refunded: boolean;
}): JourneyMoneyRows {
  if (ending.expired) return "none";
  if (ending.crypto) return ending.refunded ? "receipt" : "none";
  return ending.failed ? "receipt" : "quote";
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
