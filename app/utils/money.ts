/** Whether the string is a plain finite number ("12.50") — the only form the fiat pipeline can do
 *  arithmetic or Intl formatting on. Number("") is 0, so blanks are rejected explicitly. */
export function isMoneyAmount(amount: string | null | undefined): amount is string {
  return amount != null && amount.trim() !== "" && Number.isFinite(Number(amount));
}

/** Formats a fiat amount symbol-first: fmtFiat("50.55", "EUR") → "€50.55".
 *
 * Fiat only: Intl's currency style forces two fraction digits, which would mangle a crypto
 * amount ("0.00004545" → "0.00") — crypto rails keep the plain "amount TICKER" form. Falls
 * back to that form when the amount is not a plain number (a blank rendered as a confident
 * "€0.00" would misstate a real charge) or the code is not a well-formed currency. */
export function fmtFiat(amount: string, currency: string): string {
  if (isMoneyAmount(amount)) {
    try {
      return new Intl.NumberFormat("en", { style: "currency", currency }).format(Number(amount));
    } catch {
      // not a well-formed currency code
    }
  }
  return `${amount} ${currency}`;
}

/**
 * The sum of the amounts that are money, or null when none of them is.
 *
 * Absent and unparseable amounts are skipped rather than counted as zero: a total built from
 * nothing is not a total of zero, and a caller with nothing to total wants no total row at all.
 * Returned unrounded — `fmtFiat` rounds for display, and a caller doing further arithmetic on it
 * should not be handed a figure that has already lost its fractions.
 */
export function sumMoney(...amounts: Array<string | null | undefined>): number | null {
  const parts = amounts.filter(isMoneyAmount).map(Number);
  if (parts.length === 0) return null;
  const total = parts.reduce((acc, part) => acc + part, 0);
  return Number.isFinite(total) ? total : null;
}
