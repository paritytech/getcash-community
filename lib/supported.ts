// The live capability catalog: which regions, fiats and payment methods the adapter can deliver a
// given crypto to, and at what min/max, read from the adapter's `/supported` endpoints. Every call
// returns `null` on error.
//
// The destination is the conversion route's deposit token, not a constant: the pool tier is paid
// in the native and the PSM tier in the PSM's external, and Meld's regions, methods and limits
// differ between them. A catalog read for one and a quote placed for the other is how a supported
// region produces an unquotable request. Every cache is therefore keyed by destination, and by
// direction: a sale reads Meld's off-ramp catalog, whose regions and payout methods are its own.

import { isMeldAssetId, meldCodeOf, type MeldAssetId } from "@getsome/core";
import { adapterFetch } from "./adapter-fetch";
import { pageMeldAssets } from "./meld-assets";

/** The catalog's default destination: what the pool tier's rail asks Meld to deliver. By the app's
 *  name for the asset; Meld's code for it is read from the adapter when a catalog is fetched. */
export const DEFAULT_MELD_DESTINATION: MeldAssetId = "dot@assethub";

/** Meld's code for `asset`, once the page has the adapter's table. Throws when it cannot be read,
 *  which every caller below turns into its `null`. */
async function destinationCode(asset: MeldAssetId): Promise<string> {
  await pageMeldAssets();
  return meldCodeOf(asset);
}

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
  /** Every provider behind the method is failing the adapter's probes. The bounds are the last
   *  known ones. */
  temporarilyUnavailable?: true;
  /** An off-ramp method only: every lane the adapter found routing it, in the adapter's order,
   *  each with its own limits. The sale picks among them (see useMeldSellQuote). */
  lanes?: OfframpLaneRef[];
}

/** An off-ramp lane as the adapter names it: the asset sold and Meld's code for it, its chain and
 *  its limits. A chain other than `assethub` means the sale swaps through Chainflip first. */
export interface OfframpLaneRef {
  /** The app's name for the asset, from an adapter that sends one. */
  asset?: MeldAssetId;
  code: string;
  chain: string;
  min?: string;
  max?: string;
}

/** A (country, fiat) corridor. Empty `methods` means nothing routes here. */
export interface SupportedCorridor {
  country: string;
  fiat: string;
  methods: SupportedMethod[];
  /** The country's name, where the catalog gave one. */
  name?: string;
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

/** "in Germany", "in the United Kingdom": English puts "the" before plural and descriptive names. */
export function inCountry(name: string): string {
  const the =
    /^United |Republic$|Islands$|^(Netherlands|Philippines|Bahamas|Gambia|Maldives|Comoros)$/.test(
      name,
    );
  return `in ${the ? "the " : ""}${name}`;
}

function baseUrl(): string | undefined {
  return import.meta.env.VITE_MELD_BASE_URL as string | undefined;
}

const HEADERS = { accept: "application/json" };

/** Which way value moves through a corridor: a buy delivers the crypto, a sale takes it. The two
 *  are separate catalogs on Meld's side, with their own regions, methods and limits. */
export type SupportedDirection = "buy" | "sell";

/** How long a corridor read is reused. The adapter re-probes providers every ten minutes, so an
 *  older read can miss an outage or a recovery. */
const CORRIDOR_TTL_MS = 600_000;

/** A cache whose entries are fresh for `ttlMs`, and kept past it as the last known value. */
function expiring<V>(ttlMs: number) {
  const entries = new Map<string, { value: V; at: number }>();
  return {
    get(key: string): V | undefined {
      const entry = entries.get(key);
      return entry !== undefined && Date.now() - entry.at < ttlMs ? entry.value : undefined;
    },
    last(key: string): V | undefined {
      return entries.get(key)?.value;
    },
    set(key: string, value: V): void {
      entries.set(key, { value, at: Date.now() });
    },
  };
}

// All three keyed by direction and destination asset; a second destination is a second catalog.
const countriesCache = new Map<string, SupportedCountry[]>();
const corridorCache = expiring<SupportedCorridor>(CORRIDOR_TTL_MS);
const corridorsCache = expiring<Map<string, SupportedCorridor>>(CORRIDOR_TTL_MS);

/** A corridor with a method down is read again on the next call rather than reused, so a recovery
 *  shows at once and the answer cannot lag the catalog read after it. */
const reusable = (corridor: SupportedCorridor): boolean =>
  corridor.methods.every((m) => m.temporarilyUnavailable !== true);

/** Cache key for a catalog: a buy keeps the bare destination it always had. */
const catalogKey = (destination: MeldAssetId, direction: SupportedDirection) =>
  direction === "buy" ? destination : `sell:${destination}`;
/** Cache key for the per-country corridor, which varies by both. */
const corridorKey = (destination: MeldAssetId, country: string, direction: SupportedDirection) =>
  `${catalogKey(destination, direction)}:${country}`;
/** The query tail a direction adds; a buy adds none, as the adapter's default. */
const directionQuery = (direction: SupportedDirection) =>
  direction === "buy" ? "" : `&direction=${direction}`;

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
    ...(raw.availability === "temporarily_unavailable" ? { temporarilyUnavailable: true } : {}),
    ...lanesOf(raw.lanes),
  };
}

function lanesOf(raw: unknown): { lanes?: OfframpLaneRef[] } {
  if (!Array.isArray(raw)) return {};
  const lanes: OfframpLaneRef[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { asset, code, chain, min, max } = entry as Record<string, unknown>;
    if (typeof code !== "string" || code === "" || typeof chain !== "string" || chain === "") {
      continue;
    }
    lanes.push({
      ...(isMeldAssetId(asset) ? { asset } : {}),
      code,
      chain,
      ...(typeof min === "string" ? { min } : {}),
      ...(typeof max === "string" ? { max } : {}),
    });
  }
  return { lanes };
}

/**
 * The region dropdown, from the adapter. Cached for the tab's lifetime. Returns `null` when
 * discovery is unreachable or unconfigured.
 */
export async function fetchSupportedCountries(
  destination: MeldAssetId,
  direction: SupportedDirection = "buy",
): Promise<SupportedCountry[] | null> {
  const cached = countriesCache.get(catalogKey(destination, direction));
  if (cached !== undefined) return cached;
  const base = baseUrl();
  if (base === undefined) return null;
  try {
    const res = await adapterFetch()(
      `${base.replace(/\/$/, "")}/supported/countries?destinationCurrencyCode=${encodeURIComponent(await destinationCode(destination))}${directionQuery(direction)}`,
      { headers: HEADERS },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { countries?: Record<string, unknown>[] };
    const rows = (data.countries ?? []).map((r) => ({
      country: String(r.country ?? ""),
      name: String(r.name ?? r.country ?? ""),
    }));
    // Only a non-empty catalog is cached; an empty one is fetched again next call.
    if (rows.length > 0) countriesCache.set(catalogKey(destination, direction), rows);
    return rows;
  } catch {
    return null;
  }
}

/**
 * The methods and limits a country's corridor offers. Cached per country for ten minutes while
 * every method is up. Returns
 * `null` when discovery is unreachable; an empty `methods` array means nothing routes here.
 */
export async function fetchCorridor(
  destination: MeldAssetId,
  country: string,
  direction: SupportedDirection = "buy",
): Promise<SupportedCorridor | null> {
  const hit = corridorCache.get(corridorKey(destination, country, direction));
  if (hit !== undefined) return hit;
  const base = baseUrl();
  if (base === undefined) return null;
  try {
    const res = await adapterFetch()(
      `${base.replace(/\/$/, "")}/supported?country=${encodeURIComponent(country)}&destinationCurrencyCode=${encodeURIComponent(await destinationCode(destination))}${directionQuery(direction)}`,
      { headers: HEADERS },
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
    if (reusable(corridor))
      corridorCache.set(corridorKey(destination, country, direction), corridor);
    return corridor;
  } catch {
    return null;
  }
}

// Every supported corridor as a country -> corridor map, DB-backed and cached for ten minutes. A
// read that fails or comes back empty answers the last map read, or null before the first.
export async function fetchSupportedCorridors(
  destination: MeldAssetId,
  direction: SupportedDirection = "buy",
): Promise<Map<string, SupportedCorridor> | null> {
  const key = catalogKey(destination, direction);
  const cached = corridorsCache.get(key);
  if (cached !== undefined) return cached;
  const last = corridorsCache.last(key) ?? null;
  const base = baseUrl();
  if (base === undefined) return null;
  try {
    const res = await adapterFetch()(
      `${base.replace(/\/$/, "")}/supported/corridors?destinationCurrencyCode=${encodeURIComponent(await destinationCode(destination))}${directionQuery(direction)}`,
      { headers: HEADERS },
    );
    if (!res.ok) return last;
    const data = (await res.json()) as {
      corridors?: {
        country?: string;
        name?: string;
        fiat?: string;
        methods?: Record<string, unknown>[];
      }[];
    };
    const map = new Map<string, SupportedCorridor>();
    for (const c of data.corridors ?? []) {
      const country = String(c.country ?? "");
      const fiat = String(c.fiat ?? "");
      if (country === "") continue;
      map.set(country, {
        country,
        fiat,
        methods: (c.methods ?? []).map((m) => toMethod(m, fiat)),
        ...(typeof c.name === "string" && c.name !== "" ? { name: c.name } : {}),
      });
    }
    // An empty result (the adapter's cold cache) is no answer: it is retried on the next call.
    if (map.size === 0) return last ?? map;
    corridorsCache.set(key, map);
    return map;
  } catch {
    return last;
  }
}

// A hosted card or bank top-up is delivered in whichever of two tokens a provider quotes, so its
// region dropdown reads both tokens' buy catalogs as one. `preferred` is the catalog of the token
// tried first; where the two disagree, its answer is kept.

/** Two country lists as one, each country once and in name order, as the adapter lists them; null
 *  only when both are. */
export function mergeCountries(
  preferred: readonly SupportedCountry[] | null,
  other: readonly SupportedCountry[] | null,
): SupportedCountry[] | null {
  if (other === null) return preferred && [...preferred];
  if (preferred === null) return [...other];
  const seen = new Set(preferred.map((c) => c.country));
  return [...preferred, ...other.filter((c) => !seen.has(c.country))].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

const DECIMAL = /^(\d+)(?:\.(\d*))?$/;

/** The sign of `a - b` for two plain decimal texts, exactly; null when either is not one. */
function compareDecimal(a: string, b: string): number | null {
  const x = DECIMAL.exec(a.trim());
  const y = DECIMAL.exec(b.trim());
  if (x === null || y === null) return null;
  const places = Math.max(x[2]?.length ?? 0, y[2]?.length ?? 0);
  const scaled = (m: RegExpExecArray) => BigInt(m[1]! + (m[2] ?? "").padEnd(places, "0"));
  const diff = scaled(x) - scaled(y);
  return diff === 0n ? 0 : diff < 0n ? -1 : 1;
}

/** The lower (`sign` -1) or higher (`sign` 1) of two bounds. Blank when either cannot be read: a
 *  row is greyed on a bound we can read, never on one a side does not give. */
function widerBound(a: string, b: string, sign: -1 | 1): string {
  const order = compareDecimal(a, b);
  if (order === null) return "";
  return order * sign >= 0 ? a : b;
}

/**
 * One country's two corridors as one: a category is routed when either routes it, and where both
 * do, the first method of each is bounded by the smaller minimum and the larger maximum. Bounds in
 * two currencies are never mixed: the preferred method's stand. Where only one of the two is
 * available, it stands alone.
 */
export function mergeCorridor(
  preferred: SupportedCorridor | null,
  other: SupportedCorridor | null,
): SupportedCorridor | null {
  if (preferred === null || other === null) return preferred ?? other;
  const first = (corridor: SupportedCorridor, category: SupportedMethodCategory) =>
    corridor.methods.find((m) => m.category === category);
  const widened = (method: SupportedMethod): SupportedMethod => {
    const twin = first(other, method.category);
    if (method !== first(preferred, method.category) || twin === undefined) return method;
    if (method.temporarilyUnavailable !== twin.temporarilyUnavailable) {
      return method.temporarilyUnavailable ? twin : method;
    }
    if (twin.currency !== method.currency) return method;
    return {
      ...method,
      min: widerBound(method.min, twin.min, -1),
      max: widerBound(method.max, twin.max, 1),
      providers: [...new Set([...method.providers, ...twin.providers])],
    };
  };
  return {
    ...preferred,
    methods: [
      ...preferred.methods.map(widened),
      ...other.methods.filter((m) => first(preferred, m.category) === undefined),
    ],
  };
}

/** Two catalogs' corridors as one, country by country (see `mergeCorridor`); null only when both
 *  are. */
export function mergeCorridorMaps(
  preferred: Map<string, SupportedCorridor> | null,
  other: Map<string, SupportedCorridor> | null,
): Map<string, SupportedCorridor> | null {
  if (preferred === null || other === null) return preferred ?? other;
  const merged = new Map<string, SupportedCorridor>();
  for (const country of new Set([...preferred.keys(), ...other.keys()])) {
    const corridor = mergeCorridor(preferred.get(country) ?? null, other.get(country) ?? null);
    if (corridor !== null) merged.set(country, corridor);
  }
  return merged;
}

// The off-ramp catalog: the adapter merges Meld's sell routes for every configured lane (today's
// Asset Hub sale first, then the Chainflip lanes) and tags each country's payout method with the
// first lane that routes it. A sale reads this instead of one destination's sell catalog, so a
// region no provider buys the Asset Hub asset in still sells, through the swap.

const offrampCorridorsCache = expiring<Map<string, SupportedCorridor>>(CORRIDOR_TTL_MS);
const offrampCorridorCache = expiring<SupportedCorridor>(CORRIDOR_TTL_MS);

function corridorOf(c: Record<string, unknown>, country: string): SupportedCorridor {
  const fiat = String(c.fiat ?? "");
  const methods = Array.isArray(c.methods) ? (c.methods as Record<string, unknown>[]) : [];
  return {
    country,
    fiat,
    methods: methods.map((m) => toMethod(m, fiat)),
    ...(typeof c.name === "string" && c.name !== "" ? { name: c.name } : {}),
  };
}

/** Every off-ramp corridor as a country -> corridor map, cached for ten minutes. A read that fails
 *  or comes back empty answers the last map read, or null before the first. */
export async function fetchOfframpCorridors(): Promise<Map<string, SupportedCorridor> | null> {
  const cached = offrampCorridorsCache.get("all");
  if (cached !== undefined) return cached;
  const last = offrampCorridorsCache.last("all") ?? null;
  const base = baseUrl();
  if (base === undefined) return null;
  try {
    const res = await adapterFetch()(`${base.replace(/\/$/, "")}/supported/offramp/corridors`, {
      headers: HEADERS,
    });
    if (!res.ok) return last;
    const data = (await res.json()) as { corridors?: Record<string, unknown>[] };
    const map = new Map<string, SupportedCorridor>();
    for (const c of data.corridors ?? []) {
      const country = String(c.country ?? "");
      if (country !== "") map.set(country, corridorOf(c, country));
    }
    // An empty result (the adapter's cold cache) is no answer: it is retried on the next call.
    if (map.size === 0) return last ?? map;
    offrampCorridorsCache.set("all", map);
    return map;
  } catch {
    return last;
  }
}

/** One country's off-ramp corridor, read live. Cached per country for ten minutes; null when
 *  unreachable. */
export async function fetchOfframpCorridor(country: string): Promise<SupportedCorridor | null> {
  const hit = offrampCorridorCache.get(country);
  if (hit !== undefined) return hit;
  const base = baseUrl();
  if (base === undefined) return null;
  try {
    const res = await adapterFetch()(
      `${base.replace(/\/$/, "")}/supported/offramp?country=${encodeURIComponent(country)}`,
      { headers: HEADERS },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const corridor = corridorOf(data, String(data.country ?? country));
    if (reusable(corridor)) offrampCorridorCache.set(country, corridor);
    return corridor;
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
  /** Supported, but every provider behind the method is failing right now: greyed under its own
   *  heading, apart from the regions nothing routes to. */
  temporarilyUnavailable?: true;
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

// Picker rows for the active method: supported carries its fiat min, unsupported is disabled, a
// method whose providers are all failing is temporarily unavailable, and a minimum above `floor`
// greys the row it belongs to. Null while the corridors are unread: rows nothing can grey would
// offer regions the adapter may know to be down, so the picker offers a retry instead.
export function corridorOptions(
  base: readonly SupportedCountry[],
  corridors: Map<string, SupportedCorridor> | null,
  ui: "card" | "bank",
  floor?: FiatFloor | null,
): CountryOption[] | null {
  if (corridors === null || corridors.size === 0) return null;
  return base.map((c): CountryOption => {
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
    if (method.temporarilyUnavailable) return { ...named, temporarilyUnavailable: true };
    // A supported method with no bound or no currency stays selectable but shows no min.
    if (method.min === "" || method.currency === "") return named;
    const row: CountryOption = { ...named, min: method.min, fiat: method.currency };
    return overFloor(method.min, floor, method.currency) ? { ...row, belowMinimum: true } : row;
  });
}

/** The region's name as the live catalog writes it, else the one Intl has, else the code. Both
 *  Meld screens name their committed region this way. */
export function namedCountry(country: string, catalog: readonly SupportedCountry[] | null): string {
  return (catalog ?? []).find((c) => c.country === country)?.name ?? countryName(country);
}

/** A labelled section of the region list. A null title leads the list unheaded. */
export interface RegionGroup {
  title: string | null;
  rows: CountryOption[];
}

/** Whether a picker row commits when tapped. */
export function isPickable(o: CountryOption): boolean {
  return !o.disabled && !o.belowMinimum && !o.temporarilyUnavailable;
}

/**
 * The region list as the design sections it: what can be picked, then what cannot and why.
 *
 * A region the buyer's own device reports leads, so the common case is one tap away, and the rest
 * are what is left to choose from. Below the pickable regions come the three that are not — this
 * purchase is under the region's minimum, its providers are failing right now, or nothing routes
 * there at all — kept in the list rather than dropped, because a buyer looking for their own
 * country needs to be told why it is not on offer.
 *
 * While a filter is running there is no detected pin and the matches lead unheaded: what is being
 * shown is the search's answer, not the whole list.
 */
export function regionGroups(
  rows: readonly CountryOption[],
  detected: string | null,
  filtering = false,
): RegionGroup[] {
  const pin = filtering
    ? null
    : (rows.find((o) => o.country === detected && isPickable(o)) ?? null);
  const rest = pin ? rows.filter((o) => o !== pin) : rows;
  const groups: RegionGroup[] = [];
  const add = (title: string | null, list: CountryOption[]) => {
    if (list.length > 0) groups.push({ title, rows: list });
  };
  if (pin) add("Detected country", [pin]);
  add(
    filtering ? null : pin ? "Or choose another country" : "All countries",
    rest.filter(isPickable),
  );
  add(
    "Minimum payment amount",
    rest.filter((o) => o.belowMinimum && !o.disabled),
  );
  add(
    "Temporarily unavailable",
    rest.filter((o) => o.temporarilyUnavailable),
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

/** The fiat methods no region offers right now. None while the catalog is unread: the picker's
 *  retry answers that, not a disabled route. */
export function unservedMethods(
  corridors: ReadonlyMap<string, SupportedCorridor> | null,
): ("card" | "bank")[] {
  if (corridors === null || corridors.size === 0) return [];
  return (["card", "bank"] as const).filter(
    (ui) =>
      ![...corridors.values()].some((c) => {
        const method = methodFor(c, ui);
        return method !== null && !method.temporarilyUnavailable;
      }),
  );
}

/** The method's minimum in the corridor's fiat, or `null` when the corridor prices none. */
export function methodMinimum(
  corridor: SupportedCorridor | null,
  ui: "card" | "bank",
): { amount: string; fiat: string } | null {
  const method = methodFor(corridor, ui);
  if (method === null || method.min === "" || method.currency === "") return null;
  return { amount: method.min, fiat: method.currency };
}

/** Whether the corridor routes the method but every provider behind it is failing right now. */
export function isMethodDown(corridor: SupportedCorridor | null, ui: "card" | "bank"): boolean {
  return methodFor(corridor, ui)?.temporarilyUnavailable === true;
}
