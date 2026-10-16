// The buyer's detected region, one rule for every funding and withdraw surface: IP-geo first
// (lib/geo.ts), the device locale as the fallback. Callers add their own default and any
// rail filter.

import { computed, onMounted, ref, type ComputedRef } from "vue";
import { fetchGeoCountry, geoCountry } from "~~/lib/geo";
import { localeCountry } from "../utils/locale";

/** The decision so far, synchronously: the geo cache when it has answered, else the locale. */
export function detectedCountryNow(): string | null {
  return geoCountry() ?? localeCountry();
}

/** The decision, awaited: the bounded geo answer (lib/geo.ts) when it comes, else the locale. */
export async function detectCountry(): Promise<string | null> {
  return (await fetchGeoCountry()) ?? localeCountry();
}

/**
 * The decision as a live value, for pickers that pin the detected region: what is known now,
 * upgraded in place when the async lookup lands. Call during component setup.
 */
export function useDetectedCountry(): ComputedRef<string | null> {
  const geo = ref(geoCountry());
  onMounted(async () => {
    geo.value ??= await fetchGeoCountry();
  });
  return computed(() => geo.value ?? localeCountry());
}
