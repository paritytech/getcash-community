/** Formats a fiat amount symbol-first: fmtFiat("50.55", "EUR") → "€50.55".
 *
 * Fiat only: Intl's currency style forces two fraction digits, which would mangle a crypto
 * amount ("0.00004545" → "0.00") — crypto rails keep the plain "amount TICKER" form. Falls
 * back to that form when the code is not a well-formed currency. */
export function fmtFiat(amount: string, currency: string): string {
  const value = Number(amount);
  if (Number.isFinite(value)) {
    try {
      return new Intl.NumberFormat("en", { style: "currency", currency }).format(value);
    } catch {
      // not a well-formed currency code
    }
  }
  return `${amount} ${currency}`;
}
