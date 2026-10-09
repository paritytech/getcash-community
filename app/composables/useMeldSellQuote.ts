// The quote a fiat sale is confirmed on: the region and payout method from the adapter's off-ramp
// catalog, the exact figure the key will pay, and the best provider line for that figure. The
// catalog names, per region and method, what the sale sells: PAS on Asset Hub out of the pool sale,
// or, where no provider buys that, a lane's asset that Chainflip swaps the key's USDT into. Priced
// again whenever the region changes; nothing here opens a session.

import { ref, shallowRef } from "vue";
import {
  formatSellAmount,
  pickBestQuote,
  SELL_TOKEN,
  sellQuoteUsable,
  type MeldQuoteEntry,
} from "@getsome/meld";
import type { ConversionRoute } from "@getsome/funding";
import { laneByMeldCode, laneSellToken, type LaneId, type OfframpLane } from "@getsome/offramp";
import { OFFRAMP_LANE_ORDER } from "~~/lib/config";
import { bankRailCountries, regionForCountry } from "~~/lib/region";
import {
  countryName,
  fetchOfframpCorridor,
  fetchOfframpCorridors,
  methodFor,
  type OfframpLaneRef,
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
  /** Exactly what the provider is paid, base units of the sold asset: PAS, or the lane's. */
  cryptoAmount: bigint;
  /** A sale through an offramp lane: the lane, and the USDT redeem the withdrawal runs. */
  swap?: { lane: LaneId; route: ConversionRoute };
  /** The CASH expected back once the provider is paid, before the way back's fees; 0 when it is
   *  too small to send back. */
  backCash: bigint;
  line: MeldQuoteEntry;
}

/** What a sale commits to its provider, and its lane when it sells through one. */
type SizedSale = { planck: bigint; backCash: bigint; swap?: MeldSellQuote["swap"] };

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

/** What a sale of Meld code `code` sells: PAS on Asset Hub (null), a lane this build can swap into,
 *  or `undefined` for a code it cannot sell. */
export function saleLaneOf(code: string): OfframpLane | null | undefined {
  if (code === SELL_TOKEN.meldCurrencyCode) return null;
  return laneByMeldCode(code) ?? undefined;
}

/**
 * The lanes a sale tries, best first: the ones the adapter found routing the method, in this
 * build's order (OFFRAMP_LANE_ORDER), any other dropped. A method with no lanes, from the static
 * fallback when the catalog is unreachable, sells PAS on Asset Hub as it always has.
 */
export function laneCandidates(
  lanes: readonly OfframpLaneRef[] | undefined,
  order: readonly string[],
): string[] {
  if (lanes === undefined) return [SELL_TOKEN.meldCurrencyCode];
  return order.filter((code) => lanes.some((l) => l.code === code));
}

export function useMeldSellQuote(method: "card" | "bank", amount: bigint) {
  const country = ref(startingCountry(method));
  const countries = shallowRef<SupportedCountry[] | null>(null);
  const corridors = shallowRef<Map<string, SupportedCorridor> | null>(null);
  const quote = shallowRef<MeldSellQuote | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  let epoch = 0;

  /** The off-ramp catalog, for the region picker. Null lists when discovery is unreachable. */
  async function loadCatalog(): Promise<void> {
    const routed = await fetchOfframpCorridors();
    corridors.value = routed;
    countries.value =
      routed === null
        ? null
        : [...routed.values()].map((c) => ({
            country: c.country,
            name: c.name ?? countryName(c.country),
          }));
  }

  /**
   * The payout currency and method for a region: the live corridor when discovery answers, the
   * static table when it does not, with Meld's payout codes rather than the buy side's. Null when
   * this method pays out nowhere in the region.
   */
  async function corridorFor(
    cc: string,
  ): Promise<{ fiat: string; paymentMethodType: string; lanes?: OfframpLaneRef[] } | null> {
    const live = corridors.value?.get(cc) ?? (await fetchOfframpCorridor(cc));
    if (live !== null) {
      const found = methodFor(live, method);
      return found === null
        ? null
        : {
            fiat: live.fiat,
            paymentMethodType: found.paymentMethodType,
            ...(found.lanes === undefined ? {} : { lanes: found.lanes }),
          };
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
      // The method decides what is sold, so the corridor is read before the sale is sized.
      const corridor = await corridorFor(country.value);
      if (mine !== epoch) return;
      if (corridor === null) {
        error.value = unroutedReason();
        return;
      }
      // Best lane first; a lane whose providers will not quote falls through to the next.
      let failure = "No provider can pay out this sale right now.";
      for (const code of laneCandidates(corridor.lanes, OFFRAMP_LANE_ORDER)) {
        const lane = saleLaneOf(code);
        if (lane === undefined) continue;
        const token = lane === null ? SELL_TOKEN : laneSellToken(lane);
        try {
          const size: SizedSale =
            lane === null
              ? await live.sizeMeldCommitment(amount)
              : await live.sizeSwapSale(amount, lane).then((swap) => ({
                  planck: swap.commit,
                  backCash: 0n,
                  swap: { lane: lane.id, route: swap.route },
                }));
          if (mine !== epoch) return;
          const { quotes } = await client.getSellQuote({
            country: country.value,
            sourceCurrencyCode: token.meldCurrencyCode,
            sourceAmount: formatSellAmount(size.planck, token),
            destinationCurrencyCode: corridor.fiat,
            paymentMethodType: corridor.paymentMethodType,
          });
          if (mine !== epoch) return;
          // The best line pays the seller the most; the fees come off the payout. Only providers
          // that send the seller back for the key to pay, and only a payout that is a number.
          const line = pickBestQuote(quotes.filter(sellQuoteUsable));
          if (line === null) continue;
          quote.value = {
            country: country.value,
            fiat: corridor.fiat,
            paymentMethodType: corridor.paymentMethodType,
            cryptoAmount: size.planck,
            backCash: size.backCash,
            ...(size.swap === undefined ? {} : { swap: size.swap }),
            line,
          };
          return;
        } catch (e: unknown) {
          if (mine !== epoch) return;
          failure = e instanceof Error ? e.message : String(e);
        }
      }
      error.value = failure;
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
