// A scriptable MeldClientLike for offline use: canned quotes at a demo rate, a session with a
// stand-in hosted URL, and a fixed status. A sale follows a short script instead: a few polls of
// KYC, then the provider's deposit address, as the adapter would disclose it.

import type {
  MeldClientLike,
  MeldQuoteEntry,
  MeldSellClientLike,
  MeldStatusResult,
} from "./client";

/** A well-formed Asset Hub account for the sale's stand-in deposit address. */
const SELL_DEPOSIT_ADDRESS = "13ENScfFZXQ8avXf6cphack516B8YCjdL4MJbodm7VxK8GE9";

export interface FakeMeldOptions {
  /** Demo fiat price per whole native token. Default 7 (≈ USD/DOT ballpark). */
  usdPerToken?: number;
  /** Provider fee, percent of the pre-fee fiat. Default 3. */
  feePct?: number;
  /**
   * Provider names, cheapest first; each later one is priced slightly higher. Default TRANSAK,
   * KOYWE.
   */
  providers?: string[];
  /** Status every poll returns, in the adapter's vocabulary. Default 'session_opened'. */
  status?: string;
  /** Sale only: polls answered before the deposit address appears, standing in for the seller's
   *  KYC. Default 2. */
  sellPollsBeforeDeposit?: number;
  /** Sale only: a tag in every sale's id, so a page loaded again does not reuse the ids of the
   *  sales an earlier load opened. Default none. */
  saleIdTag?: string;
}

/** The prefix of every sale id this fake hands out. */
const SALE_ID_PREFIX = "mock-sell-";

/** The chain a headless quote names. A stand-in: Meld's code for Asset Hub is not yet known. */
const HEADLESS_NETWORK_CODE = "MOCK_ASSETHUB";

/** The flat partner fee real card quotes carry, in fiat units. */
const PARTNER_FEE = 0.5;

/** A sale this fake opened: its committed terms and how far its script has run. */
interface FakeSale {
  cryptoAmount: string;
  crypto: string;
  fiat: string;
  polls: number;
  cancelled: boolean;
  disclosedAt?: number;
}

export function createFakeMeldClient(
  opts: FakeMeldOptions = {},
): MeldClientLike & MeldSellClientLike {
  const rate = opts.usdPerToken ?? 7;
  const feePct = opts.feePct ?? 3;
  const providers = opts.providers ?? ["TRANSAK", "KOYWE"];
  // The adapter's vocabulary: `session_opened` is a live, unpaid request.
  const status = opts.status ?? "session_opened";
  const pollsBeforeDeposit = opts.sellPollsBeforeDeposit ?? 2;
  const saleIdPrefix =
    opts.saleIdTag === undefined ? SALE_ID_PREFIX : `${SALE_ID_PREFIX}${opts.saleIdTag}-`;
  let sessionSeq = 0;
  const sales = new Map<string, FakeSale>();

  /** One poll of a sale: KYC first, then the deposit terms, which stay while the row is live. */
  function saleStatus(sale: FakeSale): MeldStatusResult {
    sale.polls += 1;
    const terms = {
      fiat: sale.fiat,
      destinationCurrencyCode: sale.crypto,
      cryptoAmount: sale.cryptoAmount,
    };
    if (sale.cancelled) return { status: "session_opened", ...terms };
    if (sale.polls <= pollsBeforeDeposit) {
      return {
        status: "session_opened",
        serviceProviderWidgetUrl: "https://global-stg.transak.com/?sell=1",
        ...terms,
      };
    }
    sale.disclosedAt ??= Date.now();
    return {
      status: "transaction_seen",
      ...terms,
      deposit: {
        address: SELL_DEPOSIT_ADDRESS,
        amount: sale.cryptoAmount,
        currency: sale.crypto,
        observedAt: sale.disclosedAt,
      },
    };
  }

  return {
    async getQuote(req) {
      // Forward, like real Meld: fiat in -> crypto out. The user pays `sourceAmount`, a fee is
      // taken, and the remainder buys native at the demo rate; later providers deliver slightly
      // less.
      const fiat = Number(req.sourceAmount) || 0;
      const fee = (fiat * feePct) / 100;
      const netFiat = Math.max(fiat - fee, 0);
      const quotes: MeldQuoteEntry[] = providers.map((serviceProvider, i) => {
        const out = (netFiat / rate) * (1 - i * 0.02); // later providers a touch worse
        return {
          serviceProvider,
          sourceAmount: fiat.toFixed(2),
          destinationAmount: out.toFixed(8),
          totalFee: fee.toFixed(2),
          // Mirrors the shape real card quotes come back in: the provider's fee and our flat cut
          // sum to the total, and no network fee is quoted.
          transactionFee: Math.max(fee - PARTNER_FEE, 0).toFixed(2),
          partnerFee: PARTNER_FEE.toFixed(2),
          customerScore: 100 - i,
          ...(req.integrationMode === "headless"
            ? { destinationNetworkCode: HEADLESS_NETWORK_CODE }
            : {}),
        };
      });
      return { quotes };
    },
    async createSession() {
      sessionSeq += 1;
      const sessionId = `mock-meld-${sessionSeq}`;
      return {
        // The adapter's handle, used by status polling and resume.
        fundingRequestId: `mock-funding-${sessionSeq}`,
        sessionId,
        externalSessionId: `mock-ext-${sessionSeq}`,
        widgetUrl: `https://global-stg.transak.com/?sessionId=${sessionId}`,
        meldWidgetUrl: `https://sb.meldcrypto.com/?sessionId=${sessionId}`,
      };
    },
    async getSellQuote(req) {
      // Reverse: crypto in, fiat out. The fees are fiat, taken off the payout.
      const crypto = Number(req.sourceAmount) || 0;
      const gross = crypto * rate;
      const fee = (gross * feePct) / 100 + PARTNER_FEE;
      const quotes: MeldQuoteEntry[] = providers.map((serviceProvider, i) => {
        const out = Math.max(gross * (1 - i * 0.02) - fee, 0);
        return {
          serviceProvider,
          sourceAmount: req.sourceAmount,
          destinationAmount: out.toFixed(2),
          totalFee: fee.toFixed(2),
          transactionFee: Math.max(fee - PARTNER_FEE, 0).toFixed(2),
          partnerFee: PARTNER_FEE.toFixed(2),
          customerScore: 100 - i,
        };
      });
      return { quotes };
    },
    async createSellSession(req) {
      sessionSeq += 1;
      const fundingRequestId = `${saleIdPrefix}${sessionSeq}`;
      sales.set(fundingRequestId, {
        cryptoAmount: req.sourceAmount,
        crypto: req.sourceCurrencyCode,
        fiat: req.destinationCurrencyCode,
        polls: 0,
        cancelled: false,
      });
      const sessionId = `mock-meld-sell-${sessionSeq}`;
      return {
        fundingRequestId,
        sessionId,
        externalSessionId: `mock-ext-sell-${sessionSeq}`,
        widgetUrl: `https://global-stg.transak.com/?sessionId=${sessionId}`,
        meldWidgetUrl: `https://sb.meldcrypto.com/?sessionId=${sessionId}`,
      };
    },
    async getStatus(fundingRequestId) {
      const sale = sales.get(fundingRequestId);
      if (sale !== undefined) return saleStatus(sale);
      // A sale lives in the memory of the page that opened it: one from before a reload is gone,
      // and ends as a provider's order that ran out would, with nothing taken.
      return fundingRequestId.startsWith(SALE_ID_PREFIX) ? { status: "expired" } : { status };
    },
    async cancel(fundingRequestId) {
      const sale = sales.get(fundingRequestId);
      // A sale whose address is out cannot be withdrawn: the seller may already be sending.
      if (sale?.disclosedAt !== undefined) return { outcome: "not-cancellable" as const };
      if (sale !== undefined) sale.cancelled = true;
      return { outcome: "cancelled" as const };
    },
  };
}
