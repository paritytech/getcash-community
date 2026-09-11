/** Formats a fiat amount symbol-first: fmtFiat("50.55", "EUR") → "€50.55".
 *
 * Fiat only: Intl's currency style forces two fraction digits, which would mangle a crypto
 * amount ("0.00004545" → "0.00") — crypto rails keep the plain "amount TICKER" form. Falls
 * back to that form when the code is not a well-formed currency. */
/** Splits a quote's fee total into the provider's part and the network's, as printable amounts.
 *  Meld itemizes only the network fee; the remainder is the provider's. Returns null when the
 *  total is not a number, and folds the network fee into the provider's when it is missing or
 *  implausible (non-positive, or larger than the total). */
export function splitFees(
  fee: string | null | undefined,
  networkFee: string | null | undefined,
): { provider: string; network: string | null } | null {
  const total = Number(fee ?? Number.NaN);
  if (!Number.isFinite(total)) return null;
  const network = Number(networkFee ?? Number.NaN);
  if (!Number.isFinite(network) || network <= 0 || network > total) {
    return { provider: String(total), network: null };
  }
  return { provider: (total - network).toFixed(2), network: String(network) };
}

export function fmtFiat(amount: string, currency: string): string {
  const value = Number(amount);
  // Number("") is 0, and a blank amount printed as a confident "€0.00" misstates a real charge —
  // blanks take the plain fallback like any other unparseable amount.
  if (amount.trim() !== "" && Number.isFinite(value)) {
    try {
      return new Intl.NumberFormat("en", { style: "currency", currency }).format(value);
    } catch {
      // not a well-formed currency code
    }
  }
  return `${amount} ${currency}`;
}
