// The quote a fiat sale is confirmed on: the region and payout method from the adapter's sell
// catalog, the exact figure the key will pay out of the pool sale, and the best provider line for
// that figure. Priced again whenever the region changes; nothing here opens a session.

import { ref, shallowRef } from "vue";
import {
  formatSellAmount,
  pickBestQuote,
  SELL_TOKEN,
  sellQuoteUsable,
  type MeldQuoteEntry,
} from "@getsome/meld";
import { bankRailCountries, regionForCountry } from "~~/lib/region";
import {
  fetchCorridor,
  fetchSupportedCorridors,
  fetchSupportedCountries,
  methodFor,
  type SupportedCorridor,
  type SupportedCountry,
} from "~~/lib/supported";
import { localeCountry } from "../utils/locale";
import { meldSellClient } from "../withdraw/meld-client";

/** A priced sale: where it pays out, what the key pays, and the provider line for it. */
export interface MeldSellQuote {
  country: string;
  fiat: string;
  paymentMethodType: string;
  /** Exactly what the key pays the provider, planck. */
  cryptoAmount: bigint;
  /** The CASH expected back once the provider is paid, before the way back's fees; 0 when it is
   *  too small to send back. */
  backCash: bigint;
  line: MeldQuoteEntry;
}

/** How a sale pays out when the live catalog cannot say: Meld's payout codes, which the sell
 *  catalog names its methods by, not the buy side's card and bank codes. */
const FALLBACK_PAYOUT_METHOD = { card: "PAYOUT_TO_CARD", bank: "PAYOUT_TO_BANK" } as const;

/** The region a sale starts from: the device's own where this method pays out there, else a
 *  SEPA one, until geolocation lands. */
function startingCountry(method: "card" | "bank"): string {
  const detected = localeCountry();
  if (detected === null) return "DE";
  return method === "card" || bankRailCountries().includes(detected) ? detected : "DE";
}

export function useMeldSellQuote(method: "card" | "bank", amount: bigint) {
  const country = ref(startingCountry(method));
  const countries = shallowRef<SupportedCountry[] | null>(null);
  const corridors = shallowRef<Map<string, SupportedCorridor> | null>(null);
  const quote = shallowRef<MeldSellQuote | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  let epoch = 0;

  /** The sell catalog, for the region picker. Null lists when discovery is unreachable. */
  async function loadCatalog(): Promise<void> {
    const code = SELL_TOKEN.meldCurrencyCode;
    const [listed, routed] = await Promise.all([
      fetchSupportedCountries(code, "sell"),
      fetchSupportedCorridors(code, "sell"),
    ]);
    countries.value = listed;
    corridors.value = routed;
  }

  /**
   * The payout currency and method for a region: the live corridor when discovery answers, the
   * static table when it does not, with Meld's payout codes rather than the buy side's. Null when
   * this method pays out nowhere in the region.
   */
  async function corridorFor(
    cc: string,
  ): Promise<{ fiat: string; paymentMethodType: string } | null> {
    const code = SELL_TOKEN.meldCurrencyCode;
    const live = corridors.value?.get(cc) ?? (await fetchCorridor(code, cc, "sell"));
    if (live !== null) {
      const found = methodFor(live, method);
      return found === null
        ? null
        : { fiat: live.fiat, paymentMethodType: found.paymentMethodType };
    }
    const region = regionForCountry(cc);
    if (method === "bank" && !bankRailCountries().includes(region.country)) return null;
    return { fiat: region.fiat, paymentMethodType: FALLBACK_PAYOUT_METHOD[method] };
  }

  /** Why nothing routes here: this region alone, or every region the catalog knows, which is the
   *  account's doing and not the seller's. */
  function unroutedReason(): string {
    const noun = method === "bank" ? "Bank payouts" : "Card payouts";
    const routedAnywhere =
      corridors.value === null ||
      [...corridors.value.values()].some((c) => methodFor(c, method) !== null);
    return routedAnywhere
      ? `${noun} are not available in this country. Choose another country.`
      : `${noun} are not available right now.`;
  }

  /** Prices the sale for the current region. A newer call supersedes an older one. */
  async function refresh(): Promise<void> {
    const mine = ++epoch;
    loading.value = true;
    error.value = null;
    quote.value = null;
    try {
      const client = meldSellClient();
      if (client === null) {
        error.value = "Card and bank withdrawals are not available right now.";
        return;
      }
      const live = await import("~~/lib/withdraw-live");
      const [corridor, size] = await Promise.all([
        corridorFor(country.value),
        live.sizeMeldCommitment(amount),
      ]);
      if (mine !== epoch) return;
      if (corridor === null) {
        error.value = unroutedReason();
        return;
      }
      const { quotes } = await client.getSellQuote({
        country: country.value,
        sourceCurrencyCode: SELL_TOKEN.meldCurrencyCode,
        sourceAmount: formatSellAmount(size.planck),
        destinationCurrencyCode: corridor.fiat,
        paymentMethodType: corridor.paymentMethodType,
      });
      if (mine !== epoch) return;
      // The best line pays the seller the most; the fees come off the payout. Only providers that
      // send the seller back for the key to pay, and only a payout that is a number.
      const line = pickBestQuote(quotes.filter(sellQuoteUsable));
      if (line === null) {
        error.value = "No provider can pay out this sale right now.";
        return;
      }
      quote.value = {
        country: country.value,
        ...corridor,
        cryptoAmount: size.planck,
        backCash: size.backCash,
        line,
      };
    } catch (e: unknown) {
      if (mine === epoch) error.value = e instanceof Error ? e.message : String(e);
    } finally {
      if (mine === epoch) loading.value = false;
    }
  }

  function setCountry(next: string): void {
    country.value = next;
    void refresh();
  }

  return { country, countries, corridors, quote, loading, error, loadCatalog, refresh, setCountry };
}
