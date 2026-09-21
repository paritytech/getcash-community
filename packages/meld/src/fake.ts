// A scriptable MeldClientLike for offline use: canned quotes at a demo rate, a session with a
// stand-in hosted URL, and a fixed status. The sell direction is scripted rather than fixed,
// because the adapter does not serve it yet and everything downstream of it is being built
// against this fake: a sell only makes sense as a sequence, since its deposit terms appear
// part-way through and are withdrawn again at the end. Nothing is pushed here either — the whole
// system learns by polling — so the script advances one step per `getStatus` call.

import type { MeldClientLike, MeldQuoteEntry, MeldSellClientLike } from "./client";

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
  /**
   * Sell only: how many status polls answer before the deposit address appears. Stands in for the
   * seller working through KYC on the hosted page, which is the only reason the address is late.
   * Default 2; 0 makes it present from the first poll.
   */
  sellPollsBeforeDepositAddress?: number;
  /** Sell only: the address the provider "issues" for the seller to send to. */
  sellDepositAddress?: string;
}

/** The flat partner fee real card quotes carry, in fiat units. */
const PARTNER_FEE = 0.5;

/** A well-formed Asset Hub address, so what the sell script hands back looks like the real
 *  thing. Nothing here checks it: SS58 validation belongs at the send site, before a transfer is
 *  signed, not at this boundary. */
const DEPOSIT_ADDRESS = "14Kt4HmnCzMqUKvWcGZdLaWkLNcL4TcUSXYvKyKdbMhsvRxM";

export function createFakeMeldClient(
  opts: FakeMeldOptions = {},
): MeldClientLike & MeldSellClientLike {
  const rate = opts.usdPerToken ?? 7;
  const feePct = opts.feePct ?? 3;
  const providers = opts.providers ?? ["TRANSAK", "KOYWE"];
  // The adapter's vocabulary: `session_opened` is a live, unpaid request.
  const status = opts.status ?? "session_opened";
  const pollsBeforeAddress = opts.sellPollsBeforeDepositAddress ?? 2;
  const depositAddress = opts.sellDepositAddress ?? DEPOSIT_ADDRESS;
  let sessionSeq = 0;
  /**
   * Sell requests opened here, by funding-request id, with the polls served so far. A buy keeps
   * the old fixed answer, so only ids minted by `createSellSession` progress; that is what stops
   * the sell script from changing what the buy flows already see.
   */
  const sells = new Map<string, { polls: number; amount: string; currency: string }>();

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
        };
      });
      return { quotes };
    },
    async getSellQuote(req) {
      // Reverse: crypto in -> fiat out. The seller sends `sourceAmount` of the token, it converts
      // at the demo rate, and the fee comes off the fiat before it is paid out.
      const tokens = Number(req.sourceAmount) || 0;
      const gross = tokens * rate;
      const quotes: MeldQuoteEntry[] = providers.map((serviceProvider, i) => {
        const fee = (gross * feePct) / 100;
        const out = Math.max(gross - fee, 0) * (1 - i * 0.02); // later providers a touch worse
        return {
          serviceProvider,
          // Crypto on a sell, the reverse of the buy above, echoed exactly as it was asked for.
          // Rounding it here would round away the precision the whole crypto-amount path exists
          // to protect, in the one place downstream code reads the committed figure from.
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
    async createSellSession(req) {
      sessionSeq += 1;
      const sessionId = `mock-meld-sell-${sessionSeq}`;
      const fundingRequestId = `mock-sell-funding-${sessionSeq}`;
      // The committed crypto amount is what the provider will expect at the address it issues.
      sells.set(fundingRequestId, {
        polls: 0,
        amount: req.sourceAmount,
        currency: req.sourceCurrencyCode,
      });
      return {
        fundingRequestId,
        sessionId,
        externalSessionId: `mock-sell-ext-${sessionSeq}`,
        widgetUrl: `https://global-stg.transak.com/?sessionId=${sessionId}`,
        meldWidgetUrl: `https://sb.meldcrypto.com/?sessionId=${sessionId}`,
      };
    },
    async getStatus(fundingRequestId) {
      const sell = sells.get(fundingRequestId);
      if (!sell) return { status };
      // The sell script, one step per poll: the seller does KYC (no terms yet), the provider
      // issues the deposit terms, the seller sends and the transfer is seen, then it settles.
      // The terms go away again on settlement, because the adapter discloses them only while the
      // request is live — a caller that cached them would still be showing an address here.
      const poll = sell.polls;
      sell.polls += 1;
      if (poll < pollsBeforeAddress) return { status: "session_opened" };
      const deposit = {
        address: depositAddress,
        amount: sell.amount,
        currency: sell.currency,
        observedAt: Date.now(),
      };
      if (poll === pollsBeforeAddress) return { status: "session_opened", deposit };
      if (poll === pollsBeforeAddress + 1) return { status: "transaction_seen", deposit };
      return { status: "settled" };
    },
    async cancel() {
      return { outcome: "cancelled" as const };
    },
  };
}
