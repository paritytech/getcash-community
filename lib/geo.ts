// The buyer's region from their IP, asked of GeoJS (get.geojs.io) straight from the app. The domain
// rides the front-loaded Remote grant (host-frontload.ts), which shipped builds auto-allow, so no
// prompt is added. The lookup itself is not front-loaded: it runs the first time a card or bank
// screen asks (useDetectedCountry), so a user who never opens one never sends their address.
// `null` is "unknown" and callers fall back to the device locale.
//
// Why GeoJS: the app ships on https origins (the DotNS host, the host webview), and ip-api.com's
// free tier is http-only, which a secure document blocks as mixed content before the request
// leaves the browser — so every shipped user fell back to the locale. ipwho.is answers over https
// but meters browser (CORS) calls per origin domain at 1k a day, one budget for every user of the
// app. GeoJS answers over https with open CORS, no key, and no published rate limit; the
// country-only endpoint returns just `{ip, country, country_3, name}`.

/** How long a screen waits before falling back to the locale. The fetch itself keeps going and
 *  fills the cache for the next caller. */
const WAIT_MS = 3_000;

const GEO_URL = "https://get.geojs.io/v1/ip/country.json";

let cached: string | null = null;
let inflight: Promise<string | null> | null = null;

/** The detected country, synchronously; `null` until a fetch has succeeded. */
export function geoCountry(): string | null {
  return cached;
}

/**
 * The detected country, fetched once per tab and answered from cache after that. Only a hit is
 * remembered: a miss (offline, no grant, unknown address) is asked again on the next call, though
 * concurrent callers share one request.
 */
export async function fetchGeoCountry(): Promise<string | null> {
  if (cached !== null) return cached;

  inflight ??= (async () => {
    try {
      const res = await fetch(GEO_URL, { headers: { accept: "application/json" } });
      if (!res.ok) {
        console.warn(`[geo] lookup failed: ${res.status}`);
        return null;
      }
      // GeoJS has no success flag: a miss (reserved or unknown address) is a missing `country`.
      const data = (await res.json()) as { country?: unknown };
      const country =
        typeof data.country === "string" && /^[A-Z]{2}$/.test(data.country) ? data.country : null;
      if (country !== null) cached = country;
      else console.warn("[geo] lookup answered no country");
      return country;
    } catch (e) {
      // Offline, no Remote grant, or the origin blocked the request: the locale decides.
      console.warn("[geo] lookup failed (falling back to the locale):", e);
      return null;
    } finally {
      inflight = null;
    }
  })();

  const request = inflight;
  return new Promise((resolve) => {
    const expiry = setTimeout(() => resolve(null), WAIT_MS);
    void request.then((country) => {
      clearTimeout(expiry);
      resolve(country);
    });
  });
}
