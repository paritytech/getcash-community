// The Meld sell quote: sizes the exact crypto this withdrawal commits — once, region-independent,
// off the chain's own pool — then prices the estimated fiat payout for whichever region the
// seller picks. The two figures stay apart the whole way through (see `../withdraw/meld-sell`),
// and the region catalog this drives the picker off is a stand-in — see `../withdraw/meld-corridors`
// for why and what to point at once the adapter's own sell endpoint exists.

import { computed, ref, shallowRef } from "vue";
import {
  formatNative,
  pickBestQuote,
  type MeldClientLike,
  type MeldQuoteEntry,
  type MeldSellClientLike,
} from "@getsome/meld";
import type { Commitment } from "@getsome/withdraw";
import { sellCorridorSource } from "../withdraw/meld-corridors";
import { meldWithdrawDestinationId, type MeldWithdrawMethod } from "../withdraw/meld-sell";
import type { WithdrawalRecord } from "../funding/requests/model";
import { useMeldSellClients } from "../stores/meldSellClients";
import { useRequestsStore } from "../stores/requests";
import { requestRefKey, requestRefOf } from "../utils/request-index";
import { useWithdrawalRequest, type WithdrawalStartOutcome } from "./useWithdrawalRequest";
import { meldPaymentMethod, resolveMeldRegion } from "~~/lib/region";
import { methodFor, type SupportedCorridor, type SupportedCountry } from "~~/lib/supported";

/** The one crypto this whole surface names: what the sale sells and what today's stand-in
 *  corridor catalog is scoped to (see `MELD_DESTINATION` in `~~/lib/supported`). */
const SOURCE_CURRENCY_CODE = "DOT_ASSETHUB";

/** The region shown before the seller picks one. */
export const DEFAULT_MELD_COUNTRY = "US";

export interface MeldSellQuoteLine {
  provider: MeldQuoteEntry;
  country: string;
  fiat: string;
  paymentMethodType: string;
}

export function useMeldSellQuote(method: MeldWithdrawMethod, cashBase: bigint) {
  const requests = useRequestsStore();
  const withdrawal = useWithdrawalRequest();
  const clients = useMeldSellClients();
  const destinationId = meldWithdrawDestinationId(method);
  const sourceId = `wd:${destinationId}`;

  /** Built once `ensureCommitment` has derived this withdrawal's own number, keyed by the
   *  request-ref it will carry — the same identity a resume looks the client up by, so a
   *  same-session "leave the KYC screen, come back from the list" finds the instance that
   *  actually holds the sale's progress rather than a blank one. See `useMeldSellClients`. */
  const client = shallowRef<(MeldClientLike & MeldSellClientLike) | null>(null);

  const country = ref<string>(DEFAULT_MELD_COUNTRY);
  const countries = shallowRef<SupportedCountry[] | null>(null);
  const corridors = shallowRef<Map<string, SupportedCorridor> | null>(null);
  const corridorByCountry = corridors; // the picker reads this name; kept for parity with the buy side

  /** The exact crypto this withdrawal will commit, once sized. Region-independent: the sale's
   *  floor turns on the chain's own pool and fees, not on who is buying it. */
  const committing = ref(true);
  const commitError = ref<string | null>(null);
  const commitment = shallowRef<Commitment | null>(null);

  const loading = ref(false);
  const quoteError = ref<string | null>(null);
  /** The picked country does not route this method at all — the live corridor's own methods when
   *  loaded, the static fallback table otherwise. Mirrors `meldMethodUnavailable` on the buy
   *  side's session store. */
  const methodUnavailable = ref(false);
  const quote = shallowRef<MeldSellQuoteLine | null>(null);

  const starting = ref(false);
  const startError = ref<string | null>(null);

  /** The region priced: the live corridor's own fiat when the catalog has this country, else the
   *  static table's guess. */
  function region(): { country: string; fiat: string } {
    const live = corridors.value?.get(country.value);
    if (live && live.fiat) return { country: country.value, fiat: live.fiat };
    return resolveMeldRegion(country.value);
  }

  function paymentMethodType(): string | null {
    const live = corridors.value?.get(country.value);
    const fromLive = live ? (methodFor(live, method)?.paymentMethodType ?? null) : null;
    return fromLive ?? meldPaymentMethod(method, country.value);
  }

  const otherMethod = computed<MeldWithdrawMethod>(() => (method === "bank" ? "card" : "bank"));
  const otherMethodAvailable = computed(() => {
    const live = corridors.value?.get(country.value);
    if (live) return methodFor(live, otherMethod.value) !== null;
    return meldPaymentMethod(otherMethod.value, country.value) !== null;
  });

  async function ensureCommitment(): Promise<Commitment | null> {
    if (commitment.value) return commitment.value;
    committing.value = true;
    commitError.value = null;
    try {
      const live = await import("~~/lib/withdraw-live");
      const n = await live.nextWithdrawNumber(sourceId, (candidate) =>
        requests.hasTrace(sourceId, candidate),
      );
      // The client is keyed by this withdrawal's own request-ref from the moment its number is
      // known, so `confirm`'s `createSellSession` and every later status poll — on this mount or
      // a resumed one — run on the one instance that has ever seen this sale.
      client.value = clients.clientFor(requestRefKey(requestRefOf(sourceId, n)));
      const key = await live.withdrawKeyFor(sourceId, n);
      const sized = await live.sizeMeldCommitment(key, cashBase);
      commitment.value = sized;
      return sized;
    } catch (e) {
      commitError.value = e instanceof Error ? e.message : String(e);
      return null;
    } finally {
      committing.value = false;
    }
  }

  async function fetchQuote(): Promise<void> {
    quoteError.value = null;
    methodUnavailable.value = false;
    quote.value = null;
    const sized = await ensureCommitment();
    if (sized === null || client.value === null) return;
    const pmt = paymentMethodType();
    if (pmt === null) {
      methodUnavailable.value = true;
      return;
    }
    const { country: c, fiat } = region();
    loading.value = true;
    try {
      const { quotes } = await client.value.getSellQuote({
        country: c,
        sourceCurrencyCode: SOURCE_CURRENCY_CODE,
        sourceAmount: formatNative(sized.planck),
        destinationCurrencyCode: fiat,
        paymentMethodType: pmt,
      });
      const best = pickBestQuote(quotes ?? []);
      if (!best) {
        quoteError.value = "No provider offers this payment method or region. Try another.";
        return;
      }
      quote.value = { provider: best, country: c, fiat, paymentMethodType: pmt };
    } catch (e) {
      quoteError.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  async function init(): Promise<void> {
    const [rows, map] = await Promise.all([
      sellCorridorSource.loadCountries(),
      sellCorridorSource.loadCorridors(),
    ]);
    if (rows) countries.value = rows;
    if (map && map.size > 0) corridors.value = map;
    await fetchQuote();
  }

  function setCountry(code: string): void {
    if (code === country.value) return;
    country.value = code;
    void fetchQuote();
  }

  /** Opens the sale for the quote in hand. A no-op with nothing to confirm. */
  async function confirm(
    destination: WithdrawalRecord["destination"],
  ): Promise<WithdrawalStartOutcome> {
    const sized = commitment.value;
    const q = quote.value;
    const c = client.value;
    if (sized === null || q === null || c === null || starting.value) {
      return { ok: false, ref: null, reason: "There is no quote to confirm yet." };
    }
    starting.value = true;
    startError.value = null;
    try {
      const outcome = await withdrawal.start({
        destinationId,
        amount: cashBase,
        destination,
        // Ignored for a meld rail: `start` computes the burner's own landing account.
        landingHex: `0x${"0".repeat(64)}`,
        rail: "meld",
        meld: {
          client: c,
          serviceProvider: q.provider.serviceProvider,
          country: q.country,
          sourceCurrencyCode: SOURCE_CURRENCY_CODE,
          destinationCurrencyCode: q.fiat,
          paymentMethodType: q.paymentMethodType,
          committedAmount: sized.planck,
          quotedFiatAmount: q.provider.destinationAmount,
        },
      });
      if (!outcome.ok) startError.value = outcome.reason;
      return outcome;
    } finally {
      starting.value = false;
    }
  }

  return {
    client,
    country,
    countries,
    corridorByCountry,
    committing,
    commitError,
    commitment,
    loading,
    quoteError,
    methodUnavailable,
    quote,
    starting,
    startError,
    otherMethod,
    otherMethodAvailable,
    init,
    setCountry,
    requote: fetchQuote,
    confirm,
  };
}
