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

/** The English name of an ISO 3166-1 alpha-2 code (GB -> "United Kingdom"), for regions the live
 *  catalog did not name. Falls back to the code itself. */
export function countryName(country: string): string {
  const cc = country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return country;
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(cc) ?? cc;
  } catch {
    return cc;
  }
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
let corridorsCache: Map<string, SupportedCorridor> | null = null;

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

// Every supported corridor as a country -> corridor map, DB-backed and tab-cached; null when unreachable.
export async function fetchSupportedCorridors(): Promise<Map<string, SupportedCorridor> | null> {
  if (corridorsCache !== null) return corridorsCache;
  const base = baseUrl();
  if (base === undefined) return null;
  try {
    const res = await fetch(
      `${base.replace(/\/$/, "")}/supported/corridors?destinationCurrencyCode=${encodeURIComponent(MELD_DESTINATION)}`,
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
    if (map.size > 0) corridorsCache = map;
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
  /** Supported, but this purchase is under the corridor's minimum: greyed, and the row says so
   *  rather than letting the buyer pick a region the quote would then refuse. */
  belowMinimum?: boolean;
  /** The corridor's fiat minimum, on a row that carries one. */
  min?: string;
  /** The corridor's fiat, e.g. "GBP": names the row's currency, and denominates `min`. */
  fiat?: string;
}

/** The purchase a minimum is judged against: what this buyer is being charged, and in what. */
export interface FiatFloor {
  fiat: string;
  /** The exact decimal text of the total, as the quote wrote it. */
  amount: string;
}

/**
 * Whether `min` is above what the buyer is paying.
 *
 * Only ever asked of two amounts in the same currency — a corridor's minimum is denominated in its
 * own fiat, and nothing here holds a rate to cross from one to another. An unparseable pair is not
 * below anything: a row is greyed on a bound we can read, never on one we cannot.
 */
function overFloor(min: string, floor: FiatFloor | null | undefined, fiat: string): boolean {
  if (!floor || floor.fiat !== fiat) return false;
  // `Number("")` is 0, which would put every region in this currency out of reach; a blank is a
  // missing amount, not a free one.
  const amount = (s: string) => (s.trim() === "" ? NaN : Number(s));
  const bound = amount(min);
  const paying = amount(floor.amount);
  if (!Number.isFinite(bound) || !Number.isFinite(paying)) return false;
  return bound > paying;
}

// Trim trailing decimal zeros for display: "26.00" -> "26", "10.50" -> "10.5" (string-only, no Number()).
export function trimAmount(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

// A plain, always-selectable row (no greying, no min).
function plainRow(c: SupportedCountry): CountryOption {
  return { country: c.country, name: c.name };
}

// Picker rows for the active method: supported carries its fiat min, unsupported is disabled, and a
// minimum above `floor` greys the row it belongs to; a null/empty map leaves all rows plain.
export function corridorOptions(
  base: readonly SupportedCountry[],
  corridors: Map<string, SupportedCorridor> | null,
  ui: "card" | "bank",
  floor?: FiatFloor | null,
): CountryOption[] {
  if (corridors === null || corridors.size === 0) return base.map(plainRow);
  const rows = base.map((c): CountryOption => {
    const corridor = corridors.get(c.country) ?? null;
    const method = corridor?.methods.find((m) => m.category === ui) ?? null;
    // A region names its currency whether or not this method is routed from it: the picker greys
    // the row, it does not leave it nameless.
    const named = {
      country: c.country,
      name: c.name,
      ...(corridor ? { fiat: corridor.fiat } : {}),
    };
    if (method === null) return { ...named, disabled: true };
    // A supported method with no bound or no currency stays selectable but shows no min.
    if (method.min === "" || method.currency === "") return named;
    const row: CountryOption = { ...named, min: method.min, fiat: method.currency };
    return overFloor(method.min, floor, method.currency) ? { ...row, belowMinimum: true } : row;
  });
  // Never brick: a map that disables every row (case skew, disjoint fallback) degrades to plain selectable rows.
  return rows.some((r) => !r.disabled) ? rows : base.map(plainRow);
}

/** A labelled section of the region list. A null title leads the list unheaded. */
export interface RegionGroup {
  title: string | null;
  rows: CountryOption[];
}

/**
 * The region list as the design sections it: what can be picked, then what cannot and why.
 *
 * A region the buyer's own device reports leads, so the common case is one tap away. Below the
 * pickable regions come the two that are not — this purchase is under the region's minimum, or
 * nothing routes there at all — kept in the list rather than dropped, because a buyer looking for
 * their own country needs to be told why it is not on offer.
 *
 * While a filter is running there is no detected pin and the matches lead unheaded: what is being
 * shown is the search's answer, not the whole list.
 */
export function regionGroups(
  rows: readonly CountryOption[],
  detected: string | null,
  filtering = false,
): RegionGroup[] {
  const pickable = (o: CountryOption) => !o.disabled && !o.belowMinimum;
  const pin = filtering ? null : (rows.find((o) => o.country === detected && pickable(o)) ?? null);
  const rest = pin ? rows.filter((o) => o !== pin) : rows;
  const groups: RegionGroup[] = [];
  const add = (title: string | null, list: CountryOption[]) => {
    if (list.length > 0) groups.push({ title, rows: list });
  };
  if (pin) add("Detected currency", [pin]);
  add(filtering ? null : "All currencies", rest.filter(pickable));
  add(
    "Minimum payment amount",
    rest.filter((o) => o.belowMinimum && !o.disabled),
  );
  add(
    "Unsupported country",
    rest.filter((o) => o.disabled),
  );
  return groups;
}

/** The first method of the given category in a corridor, or `null` when it offers none. */
export function methodFor(
  corridor: SupportedCorridor | null,
  ui: "card" | "bank",
): SupportedMethod | null {
  if (corridor === null) return null;
  return corridor.methods.find((m) => m.category === ui) ?? null;
}
