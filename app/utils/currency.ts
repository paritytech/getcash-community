// Buyer-facing names for the fiat codes the Meld rail quotes in.

/**
 * The currency's own name for an ISO 4217 code ("GBP" -> "British pound").
 *
 * Sentence case, which is how the design writes them ("Brazilian real", "Swiss franc"); `Intl`
 * title-cases every word. An all-caps first word ("US Dollar") keeps its case. Falls back to the
 * code itself where the runtime has no name for it.
 */
export function currencyName(fiat: string): string {
  const code = fiat.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return fiat;
  let name: string;
  try {
    name = new Intl.DisplayNames(["en"], { type: "currency" }).of(code) ?? code;
  } catch {
    return code;
  }
  return name
    .split(" ")
    .map((word, i) => (i === 0 ? word : word.toLowerCase()))
    .join(" ");
}
