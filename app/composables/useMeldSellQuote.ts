// The quote a fiat sale is confirmed on: the region and payout method from the adapter's off-ramp
// catalog, the exact figure the key will pay, and the best provider line for that figure. Priced
// again whenever the region changes; nothing here opens a session. The catalog's candidates decide
// what the sale sells and in which order they are tried; the chain decides, per candidate, whether
// it can serve the sale and sizes the figure.

import { ref, shallowRef, toValue, watch, type MaybeRefOrGetter } from "vue";
import { meldAssetOf, type MeldAssetId } from "@getsome/core";
import {
  directSellToken,
  ensureMeldAssets,
  formatSellAmount,
  isDirectSellCode,
  isDirectUsdt,
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
  type SupportedMethod,
} from "~~/lib/supported";
import { detectedCountryNow } from "./useDetectedCountry";
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
  /** A direct sale quoted under a code other than Meld's code for DOT, which the session must name
   *  too: its code for USDT on Asset Hub. */
  sellCode?: string;
  /** The sale the worker makes for a direct sale, as the chain decided it for the candidate: the
   *  PSM redeem for USDT, the pool for PAS. */
  route?: ConversionRoute;
  /** The CASH expected back once the provider is paid, before the way back's fees; 0 when it is
   *  too small to send back. */
  backCash: bigint;
  line: MeldQuoteEntry;
}

/** What a sale commits to its provider, and its lane when it sells through one, or its redeem when
 *  it sells USDT directly. */
type SizedSale = {
  planck: bigint;
  backCash: bigint;
  swap?: MeldSellQuote["swap"];
  route?: ConversionRoute;
};

/** How a sale pays out when the live catalog cannot say: Meld's payout codes, which the sell
 *  catalog names its methods by, not the buy side's card and bank codes. */
const FALLBACK_PAYOUT_METHOD = { card: "PAYOUT_TO_CARD", bank: "PAYOUT_TO_BANK" } as const;

/** The payout country the last sale was on. A route switch (bank to card) mounts a new sale, and
 *  the seller's choice should outlive it. */
let lastCountry: string | null = null;

/** The region a sale starts from: the one chosen before, else the geo cache where detection has
 *  already answered, else the device locale, UNfiltered — a region with no payout rail still
 *  prices as "choose another country", which is the truth about the seller. The route re-commits
 *  once the async lookup lands (MeldWithdrawRoute), unless the seller chose before. */
function startingCountry(): string {
  return lastCountry ?? detectedCountryNow() ?? "DE";
}

/** What a sale of Meld code `code` sells: an asset on Asset Hub with no swap (null), PAS or USDT,
 *  a lane this build can swap into, or `undefined` for a code it cannot sell. */
export function saleLaneOf(code: string): OfframpLane | null | undefined {
  if (isDirectSellCode(code)) return null;
  return laneByMeldCode(code) ?? undefined;
}

/** The asset a lane sells: the adapter's own name for it, or the one the asset table gives its
 *  code, for an adapter that sends none. */
const laneAsset = (lane: OfframpLaneRef): MeldAssetId | undefined =>
  lane.asset ?? meldAssetOf(lane.code);

/** Sizes a direct sale under `code` on the route the chain decides for its token, with `reserved`
 *  of the PSM's room spoken for: USDT out of the PSM, or PAS out of the pool. A USDT sale the PSM
 *  cannot serve is refused, so the next candidate is tried: this build does not sell USDT to a
 *  provider through the pool. */
async function sizeDirectSale(
  live: typeof import("~~/lib/withdraw-live"),
  code: string,
  amount: bigint,
  reserved: bigint,
): Promise<SizedSale> {
  const usdt = isDirectUsdt(code);
  const route = await live.chooseWithdrawRoute(amount, usdt ? "USDT" : "native", reserved);
  if (usdt && route.tier !== "psm") {
    throw new Error("USDT cannot be redeemed for this sale right now.");
  }
  return { ...(await live.sizeMeldCommitment(amount, route)), route };
}

/**
 * The lanes a sale tries, best first: the ones the adapter found routing the method, in this
 * build's order (OFFRAMP_LANE_ORDER), any other dropped. A method with no lanes, from the static
 * fallback when the catalog is unreachable, sells PAS on Asset Hub as it always has.
 */
export function laneCandidates(
  lanes: readonly OfframpLaneRef[] | undefined,
  order: readonly MeldAssetId[],
): string[] {
  if (lanes === undefined) return [SELL_TOKEN.meldCurrencyCode];
  return order.flatMap((asset) => lanes.find((l) => laneAsset(l) === asset)?.code ?? []);
}

/** The smallest and largest of the lanes' limits, or the method's own when a lane names none. */
function laneLimits(
  lanes: readonly OfframpLaneRef[],
  method: SupportedMethod,
): { min: string; max: string } {
  const pick = (
    values: (string | undefined)[],
    fallback: string,
    better: (a: number, b: number) => boolean,
  ) => {
    if (values.some((v) => v === undefined || !Number.isFinite(Number(v)))) return fallback;
    return (values as string[]).reduce((best, v) => (better(Number(v), Number(best)) ? v : best));
  };
  return {
    min: pick(
      lanes.map((l) => l.min),
      method.min,
      (a, b) => a < b,
    ),
    max: pick(
      lanes.map((l) => l.max),
      method.max,
      (a, b) => a > b,
    ),
  };
}

/**
 * A corridor cut down to what this build sells: each method keeps only the lanes in `order` that
 * this build can sell, and a method left with none is dropped. The picker then greys the region and
 * the quote says the payout isn't available there, rather than trying no lane and calling it a
 * passing failure. A method that came without lanes is kept: it sells PAS on Asset Hub.
 */
export function sellableCorridor(
  corridor: SupportedCorridor,
  order: readonly MeldAssetId[],
): SupportedCorridor {
  const methods = corridor.methods.flatMap((method): SupportedMethod[] => {
    if (method.lanes === undefined) return [method];
    const lanes = method.lanes.filter((l) => {
      const asset = laneAsset(l);
      return asset !== undefined && order.includes(asset) && saleLaneOf(l.code) !== undefined;
    });
    if (lanes.length === 0) return [];
    if (lanes.length === method.lanes.length) return [method];
    return [{ ...method, ...laneLimits(lanes, method), lanes }];
  });
  return { ...corridor, methods };
}

/** `reserved` is the CASH this app's other PSM withdrawals have yet to redeem, which the PSM's room
 *  is judged without for every candidate. */
export function useMeldSellQuote(
  method: "card" | "bank",
  amount: bigint,
  reserved: MaybeRefOrGetter<bigint>,
) {
  /** The starting region is one the seller chose on the other method, not a detected one. */
  const chosenBefore = lastCountry !== null;
  const country = ref(startingCountry());
  watch(country, (next) => {
    lastCountry = next;
  });
  const countries = shallowRef<SupportedCountry[] | null>(null);
  const corridors = shallowRef<Map<string, SupportedCorridor> | null>(null);
  const quote = shallowRef<MeldSellQuote | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  /** Why the sale has no quote: the region pays out nothing by this method, or the price could not
   *  be had, which is usually passing. */
  const errorKind = ref<"unrouted" | "rate" | null>(null);
  /** Price failures in a row; the screen gives up on retrying after the second. */
  const rateFailures = ref(0);
  let epoch = 0;

  function fail(kind: "unrouted" | "rate", message: string): void {
    error.value = message;
    errorKind.value = kind;
    if (kind === "rate") rateFailures.value += 1;
  }

  /** Meld's codes for the assets a sale names, read once from the adapter the sale goes through. */
  async function assetsRead(): Promise<void> {
    const client = meldSellClient();
    if (client !== null) await ensureMeldAssets(client);
  }

  /** The off-ramp catalog, for the region picker. Null lists when discovery is unreachable. */
  async function loadCatalog(): Promise<void> {
    // Unread, a lane is matched by the asset the adapter names for it, and one it names none for
    // is not sold; the quote below asks again.
    await assetsRead().catch(() => undefined);
    const fetched = await fetchOfframpCorridors();
    // Only the lanes this build sells: a region routed by none of them is greyed, not offered.
    const routed =
      fetched === null
        ? null
        : new Map([...fetched].map(([cc, c]) => [cc, sellableCorridor(c, OFFRAMP_LANE_ORDER)]));
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
    const read = corridors.value?.get(cc) ?? (await fetchOfframpCorridor(cc));
    const live = read === null ? null : sellableCorridor(read, OFFRAMP_LANE_ORDER);
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

  /** Nothing routes here: this region alone, or every region the catalog knows, which is the
   *  account's doing and not the seller's, so it reads as a passing failure. */
  function failUnrouted(): void {
    const routedAnywhere =
      corridors.value === null ||
      [...corridors.value.values()].some((c) => methodFor(c, method) !== null);
    if (routedAnywhere) {
      fail(
        "unrouted",
        `${method === "bank" ? "Bank" : "Card"} payout isn't available in this region`,
      );
    } else {
      fail("rate", `${method === "bank" ? "Bank" : "Card"} payouts are not available right now.`);
    }
  }

  /** Prices the sale for the current region. A newer call supersedes an older one. */
  async function refresh(): Promise<void> {
    const mine = ++epoch;
    loading.value = true;
    error.value = null;
    errorKind.value = null;
    quote.value = null;
    try {
      const client = meldSellClient();
      if (client === null) {
        fail("rate", "Card and bank withdrawals are not available right now.");
        return;
      }
      await ensureMeldAssets(client);
      const live = await import("~~/lib/withdraw-live");
      const corridor = await corridorFor(country.value);
      if (mine !== epoch) return;
      if (corridor === null) {
        failUnrouted();
        return;
      }
      // Best lane first; a lane whose providers will not quote falls through to the next.
      const candidates = laneCandidates(corridor.lanes, OFFRAMP_LANE_ORDER);
      // No lane this build sells routes here: the region's payout is unavailable, not passing.
      if (candidates.length === 0) {
        failUnrouted();
        return;
      }
      let failure: string | undefined;
      for (const code of candidates) {
        const lane = saleLaneOf(code);
        if (lane === undefined) continue;
        // A direct sale is quoted under the code the catalog routed, which its providers buy.
        const token = lane === null ? directSellToken(code) : laneSellToken(lane);
        try {
          const size: SizedSale =
            lane === null
              ? await sizeDirectSale(live, code, amount, toValue(reserved))
              : await live.sizeSwapSale(amount, lane, toValue(reserved)).then((swap) => ({
                  planck: swap.promise,
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
            ...(lane === null && code !== SELL_TOKEN.meldCurrencyCode ? { sellCode: code } : {}),
            ...(size.route === undefined ? {} : { route: size.route }),
            line,
          };
          rateFailures.value = 0;
          return;
        } catch (e: unknown) {
          if (mine !== epoch) return;
          const message = e instanceof Error ? e.message : String(e);
          console.warn(`[sell] lane ${code} skipped: ${message}`);
          // The best lane's failure says most about why the sale cannot be priced.
          failure ??= message;
        }
      }
      fail("rate", failure ?? "No provider can pay out this sale right now.");
    } catch (e: unknown) {
      if (mine === epoch) fail("rate", e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === epoch) loading.value = false;
    }
  }

  function setCountry(next: string): void {
    country.value = next;
    void refresh();
  }

  return {
    country,
    chosenBefore,
    countries,
    corridors,
    quote,
    loading,
    error,
    errorKind,
    rateFailures,
    loadCatalog,
    refresh,
    setCountry,
  };
}
