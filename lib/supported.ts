// The live capability catalog: which regions, fiats and payment methods the adapter can deliver
// DOT_ASSETHUB to, and at what min/max, read from the adapter's `/supported` endpoints. Every call
// returns `null` on error.

/** The crypto every catalog query is for. */
export const MELD_DESTINATION = "DOT_ASSETHUB";

export type SupportedMethodCategory = "card" | "bank" | "wallet" | "other";

/** One payment method a corridor offers, with its fiat limits. */
export interface SupportedMethod {
  /** Canonical Meld method id, sent as `paymentMethodType`, e.g. CREDIT_DEBIT_CARD, SEPA, PIX. */
  paymentMethodType: string;
  category: SupportedMethodCategory;
  /** Exact decimal text, in `currency` units. */
  min: string;
  max: string;
  currency: string;
  providers: string[];
}

/** A (country, fiat) corridor. Empty `methods` means nothing routes here. */
export interface SupportedCorridor {
  country: string;
  fiat: string;
  methods: SupportedMethod[];
}

/** One region-dropdown row. Deliverability is answered per selection by `fetchCorridor`. */
export interface SupportedCountry {
  country: string;
  name: string;
}

/** The flag emoji for an ISO 3166-1 alpha-2 code (US -> 🇺🇸), from regional-indicator symbols. */
export function flagEmoji(country: string): string {
  const cc = country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return "🏳️";
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65)));
}

function baseUrl(): string | undefined {
  return import.meta.env.VITE_MELD_BASE_URL as string | undefined;
}

function headers(): Record<string, string> {
  return {
    accept: "application/json",
    "x-dev-product-id":
      (import.meta.env.VITE_MELD_PRODUCT_ID as string | undefined) ?? "getcash.dev",
  };
}

let countriesCache: SupportedCountry[] | null = null;
const corridorCache = new Map<string, SupportedCorridor>();

function isCategory(value: unknown): value is SupportedMethodCategory {
  return value === "card" || value === "bank" || value === "wallet" || value === "other";
}

function toMethod(raw: Record<string, unknown>, fiat: string): SupportedMethod {
  return {
    paymentMethodType: String(raw.paymentMethodType ?? ""),
    category: isCategory(raw.category) ? raw.category : "other",
    min: String(raw.min ?? ""),
    max: String(raw.max ?? ""),
    currency: String(raw.currency ?? fiat),
    providers: Array.isArray(raw.providers) ? raw.providers.map(String) : [],
  };
}

/**
 * The region dropdown, from the adapter. Cached for the tab's lifetime. Returns `null` when
 * discovery is unreachable or unconfigured.
 */
export async function fetchSupportedCountries(): Promise<SupportedCountry[] | null> {
  if (countriesCache !== null) return countriesCache;
  const base = baseUrl();
  if (base === undefined) return null;
  try {
    const res = await fetch(
      `${base.replace(/\/$/, "")}/supported/countries?destinationCurrencyCode=${encodeURIComponent(MELD_DESTINATION)}`,
      { headers: headers() },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { countries?: Record<string, unknown>[] };
    const rows = (data.countries ?? []).map((r) => ({
      country: String(r.country ?? ""),
      name: String(r.name ?? r.country ?? ""),
    }));
    // Only a non-empty catalog is cached; an empty one is fetched again next call.
    if (rows.length > 0) countriesCache = rows;
    return rows;
  } catch {
    return null;
  }
}

/**
 * The methods and limits a country's corridor offers. Cached per country. Returns `null` when
 * discovery is unreachable; an empty `methods` array means nothing routes here.
 */
export async function fetchCorridor(country: string): Promise<SupportedCorridor | null> {
  const hit = corridorCache.get(country);
  if (hit !== undefined) return hit;
  const base = baseUrl();
  if (base === undefined) return null;
  try {
    const res = await fetch(
      `${base.replace(/\/$/, "")}/supported?country=${encodeURIComponent(country)}&destinationCurrencyCode=${encodeURIComponent(MELD_DESTINATION)}`,
      { headers: headers() },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      country?: string;
      fiat?: string;
      methods?: Record<string, unknown>[];
    };
    // The fiat is resolved server-side from the country's default.
    const fiat = String(data.fiat ?? "");
    const corridor: SupportedCorridor = {
      country: String(data.country ?? country),
      fiat,
      methods: (data.methods ?? []).map((m) => toMethod(m, fiat)),
    };
    corridorCache.set(country, corridor);
    return corridor;
  } catch {
    return null;
  }
}

/** The first method of the given category in a corridor, or `null` when it offers none. */
export function methodFor(
  corridor: SupportedCorridor | null,
  ui: "card" | "bank",
): SupportedMethod | null {
  if (corridor === null) return null;
  return corridor.methods.find((m) => m.category === ui) ?? null;
}
