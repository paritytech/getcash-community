// The live capability catalog: which regions, fiats and payment methods the adapter can deliver a
// given crypto to, and at what min/max, read from the adapter's `/supported` endpoints. Every call
// returns `null` on error.
//
// The destination is the conversion route's deposit token, not a constant: the pool tier is paid
// in the native and the PSM tier in the PSM's external, and Meld's regions, methods and limits
// differ between them. A catalog read for one and a quote placed for the other is how a supported
// region produces an unquotable request. Every cache is therefore keyed by destination.

/** The catalog's default destination: what the pool tier's rail asks Meld to deliver. */
export const DEFAULT_MELD_DESTINATION = "DOT_ASSETHUB";

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

// All three keyed by destination currency code; a second destination is a second catalog.
const countriesCache = new Map<string, SupportedCountry[]>();
const corridorCache = new Map<string, SupportedCorridor>();
const corridorsCache = new Map<string, Map<string, SupportedCorridor>>();

/** Cache key for the per-country corridor, which varies by both. */
const corridorKey = (destination: string, country: string) => `${destination}:${country}`;

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
export async function fetchSupportedCountries(
  destination: string,
): Promise<SupportedCountry[] | null> {
  const cached = countriesCache.get(destination);
  if (cached !== undefined) return cached;
  const base = baseUrl();
  if (base === undefined) return null;
  try {
    const res = await fetch(
      `${base.replace(/\/$/, "")}/supported/countries?destinationCurrencyCode=${encodeURIComponent(destination)}`,
      { headers: headers() },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { countries?: Record<string, unknown>[] };
    const rows = (data.countries ?? []).map((r) => ({
      country: String(r.country ?? ""),
      name: String(r.name ?? r.country ?? ""),
    }));
    // Only a non-empty catalog is cached; an empty one is fetched again next call.
    if (rows.length > 0) countriesCache.set(destination, rows);
    return rows;
  } catch {
    return null;
  }
}

/**
 * The methods and limits a country's corridor offers. Cached per country. Returns `null` when
 * discovery is unreachable; an empty `methods` array means nothing routes here.
 */
export async function fetchCorridor(
  destination: string,
  country: string,
): Promise<SupportedCorridor | null> {
  const hit = corridorCache.get(corridorKey(destination, country));
  if (hit !== undefined) return hit;
  const base = baseUrl();
  if (base === undefined) return null;
  try {
    const res = await fetch(
      `${base.replace(/\/$/, "")}/supported?country=${encodeURIComponent(country)}&destinationCurrencyCode=${encodeURIComponent(destination)}`,
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
    corridorCache.set(corridorKey(destination, country), corridor);
    return corridor;
  } catch {
    return null;
  }
}

// Every supported corridor as a country -> corridor map, DB-backed and tab-cached; null when unreachable.
export async function fetchSupportedCorridors(
  destination: string,
): Promise<Map<string, SupportedCorridor> | null> {
  const cached = corridorsCache.get(destination);
  if (cached !== undefined) return cached;
  const base = baseUrl();
  if (base === undefined) return null;
  try {
    const res = await fetch(
      `${base.replace(/\/$/, "")}/supported/corridors?destinationCurrencyCode=${encodeURIComponent(destination)}`,
      { headers: headers() },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      corridors?: { country?: string; fiat?: string; methods?: Record<string, unknown>[] }[];
    };
    const map = new Map<string, SupportedCorridor>();
    for (const c of data.corridors ?? []) {
      const country = String(c.country ?? "");
      const fiat = String(c.fiat ?? "");
      if (country === "") continue;
      map.set(country, { country, fiat, methods: (c.methods ?? []).map((m) => toMethod(m, fiat)) });
    }
    // Only a non-empty result is cached; an empty one (cold cache) is retried next call.
    if (map.size > 0) corridorsCache.set(destination, map);
    return map;
  } catch {
    return null;
  }
}

/** One picker row: a country, its availability for the active method, and its fiat minimum. */
export interface CountryOption {
  country: string;
  name: string;
  /** Unsupported for the active method: rendered greyed and non-selectable. */
  disabled?: boolean;
  /** The corridor's fiat minimum, on a supported row that carries one. */
  min?: string;
  /** The fiat the min is denominated in, e.g. "GBP". */
  currency?: string;
}

// Trim trailing decimal zeros for display: "26.00" -> "26", "10.50" -> "10.5" (string-only, no Number()).
export function trimAmount(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

// A plain, always-selectable row (no greying, no min).
function plainRow(c: SupportedCountry): CountryOption {
  return { country: c.country, name: c.name };
}

// Picker rows for the active method: supported carries its fiat min, unsupported is disabled; a null/empty map leaves all rows plain.
export function corridorOptions(
  base: readonly SupportedCountry[],
  corridors: Map<string, SupportedCorridor> | null,
  ui: "card" | "bank",
): CountryOption[] {
  if (corridors === null || corridors.size === 0) return base.map(plainRow);
  const rows = base.map((c): CountryOption => {
    const method = corridors.get(c.country)?.methods.find((m) => m.category === ui) ?? null;
    if (method === null) return { country: c.country, name: c.name, disabled: true };
    // A supported method with no bound or no currency stays selectable but shows no min.
    if (method.min === "" || method.currency === "") return { country: c.country, name: c.name };
    return { country: c.country, name: c.name, min: method.min, currency: method.currency };
  });
  // Never brick: a map that disables every row (case skew, disjoint fallback) degrades to plain selectable rows.
  return rows.some((r) => !r.disabled) ? rows : base.map(plainRow);
}

// Next non-disabled index from `from` stepping by `delta`, wrapping; -1 when none is selectable.
export function nextSelectable(
  options: readonly CountryOption[],
  from: number,
  delta: number,
): number {
  const n = options.length;
  if (n === 0) return -1;
  for (let step = 1; step <= n; step += 1) {
    const idx = (((from + delta * step) % n) + n) % n;
    if (!options[idx]?.disabled) return idx;
  }
  return -1;
}

// First non-disabled index, or -1 when none is selectable.
export function firstSelectable(options: readonly CountryOption[]): number {
  return options.findIndex((o) => !o.disabled);
}

/** A labelled picker section: the heading and its options, each tagged with its `ordered` index. */
export interface CountryGroup {
  label: string;
  options: { o: CountryOption; index: number }[];
}

// Split rows into the detected pin, supported, and unsupported groups. `ordered` is the flat
// keyboard-nav order (detected, supported, unsupported); every group option's `index` is its
// position in `ordered`, so the two never drift apart.
export function groupOptions(
  rows: readonly CountryOption[],
  selected: string,
): { ordered: CountryOption[]; groups: CountryGroup[] } {
  const detected = rows.find((o) => o.country === selected) ?? null;
  const others = rows.filter((o) => o.country !== selected);
  const supported = others.filter((o) => !o.disabled);
  const unsupported = others.filter((o) => o.disabled);
  const ordered = [...(detected ? [detected] : []), ...supported, ...unsupported];
  const groups: CountryGroup[] = [];
  let i = 0;
  const add = (label: string, list: readonly CountryOption[]) => {
    if (list.length === 0) return;
    groups.push({ label, options: list.map((o) => ({ o, index: i++ })) });
  };
  if (detected) add("Detected country", [detected]);
  add(detected ? "Or choose another country" : "Countries", supported);
  add("Unsupported country", unsupported);
  return { ordered, groups };
}

/** The first method of the given category in a corridor, or `null` when it offers none. */
export function methodFor(
  corridor: SupportedCorridor | null,
  ui: "card" | "bank",
): SupportedMethod | null {
  if (corridor === null) return null;
  return corridor.methods.find((m) => m.category === ui) ?? null;
}
