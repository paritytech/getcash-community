// What the device's own locale says about the buyer, for screens that have to guess a region
// before geolocation lands.

/**
 * The device's own region, e.g. "BR" for a pt-BR phone.
 *
 * Testers landed on the pay screen already quoting US and did not read the picker as something
 * they had to change, so a Brazilian card was priced against a US corridor and declined. The
 * device locale is the closest thing to the buyer's real region available without the geolocation
 * scope: still a guess, but a guess drawn from the buyer rather than from us. Returns null on
 * anything that is not a plain alpha-2 region, so the caller keeps its own default.
 */
export function localeCountry(): string | null {
  if (typeof navigator === "undefined") return null;
  const tag = navigator.language;
  if (!tag) return null;
  try {
    // `maximize()` supplies the region a bare language tag omits ("pt" -> "pt-Latn-BR").
    const region = new Intl.Locale(tag).maximize().region;
    return region !== undefined && /^[A-Z]{2}$/.test(region) ? region : null;
  } catch {
    return null;
  }
}
