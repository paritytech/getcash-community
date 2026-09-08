// The buyer's Meld region (country + fiat) and the region-specific bank payment-method code.
// Without an explicit country the neutral US/USD default is sent.

export interface MeldRegion {
  /** ISO 3166-1 alpha-2, e.g. "US", "IN", "BR". */
  country: string;
  /** ISO 4217 fiat, e.g. "USD", "INR". */
  fiat: string;
}

/** Country -> default fiat. A country absent here falls back to US/USD as a whole. */
const COUNTRY_FIAT: Record<string, string> = {
  US: "USD",
  IN: "INR",
  BR: "BRL",
  GB: "GBP",
  CA: "CAD",
  AU: "AUD",
  JP: "JPY",
  CH: "CHF",
  MX: "MXN",
  AE: "AED",
  TR: "TRY",
  SG: "SGD",
  NG: "NGN",
  ZA: "ZAR",
  DE: "EUR",
  FR: "EUR",
  ES: "EUR",
  IT: "EUR",
  NL: "EUR",
  PT: "EUR",
  IE: "EUR",
  AT: "EUR",
  BE: "EUR",
  FI: "EUR",
  GR: "EUR",
  LU: "EUR",
};

const DEFAULT_REGION: MeldRegion = { country: "US", fiat: "USD" };

/** Country -> Meld bank payment-method code. Meld has no generic bank code; a country absent here
 *  has no bank route and is card only. */
const COUNTRY_BANK_RAIL: Record<string, string> = {
  GB: "OPEN_BANKING",
  DE: "SEPA",
  FR: "SEPA",
  ES: "SEPA",
  IT: "SEPA",
  NL: "SEPA",
  PT: "SEPA",
  IE: "SEPA",
  AT: "SEPA",
  BE: "SEPA",
  FI: "SEPA",
  GR: "SEPA",
  LU: "SEPA",
};

/** The Meld `paymentMethodType` for a UI method + country. Card is global; bank resolves to the
 *  country's rail, or null when there is none. */
export function meldPaymentMethod(method: "card" | "bank", country: string): string | null {
  if (method === "card") return "CREDIT_DEBIT_CARD";
  return COUNTRY_BANK_RAIL[country] ?? null;
}

/** The region for a country, or US/USD when its fiat is unknown. */
export function regionForCountry(country: string): MeldRegion {
  const fiat = COUNTRY_FIAT[country];
  return fiat ? { country, fiat } : DEFAULT_REGION;
}

/**
 * The buyer's Meld region: the explicit `country` when given, else the US/USD default.
 */
export function resolveMeldRegion(country?: string): MeldRegion {
  return country ? regionForCountry(country) : DEFAULT_REGION;
}
