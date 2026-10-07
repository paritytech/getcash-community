// The buyer's region from their IP, asked of ip-api.com (the same service the host app's
// IpCountryDetectionService uses) straight from the app. The domain rides the front-loaded
// Remote grant (host-frontload.ts), which shipped builds auto-allow, so no prompt is added.
// `null` is "unknown" and callers fall back to the device locale. NOTE: ip-api.com's free tier
// is plain http, which a secure (https) document refuses as mixed content — fine over the host
// bridge and on http dev origins, but verify in the shipped webview.

/** How long a screen waits before falling back to the locale. The fetch itself keeps going and
 *  fills the cache for the next caller. */
const WAIT_MS = 3_000;

const GEO_URL = "http://ip-api.com/json";

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
      if (!res.ok) return null;
      const data = (await res.json()) as { countryCode?: unknown };
      const country =
        typeof data.countryCode === "string" && /^[A-Z]{2}$/.test(data.countryCode)
          ? data.countryCode
          : null;
      if (country !== null) cached = country;
      return country;
    } catch {
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
