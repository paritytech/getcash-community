// A scriptable MeldClientLike for offline use: canned quotes at a demo rate, a session with a
// stand-in hosted URL, and a fixed status.

import type { MeldClientLike, MeldQuoteEntry } from "./client";

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
}

export function createFakeMeldClient(opts: FakeMeldOptions = {}): MeldClientLike {
  const rate = opts.usdPerToken ?? 7;
  const feePct = opts.feePct ?? 3;
  const providers = opts.providers ?? ["TRANSAK", "KOYWE"];
  // The adapter's vocabulary: `session_opened` is a live, unpaid request.
  const status = opts.status ?? "session_opened";
  let sessionSeq = 0;

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
          networkFee: "0.01",
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
    async getStatus() {
      return { status };
    },
    async cancel() {
      return { outcome: "cancelled" as const };
    },
  };
}
