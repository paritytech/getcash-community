// Shared top-up adapter helpers: the durable record as the adapters read it, and the amount a
// claim credited.

import { fmtCash } from "../utils/cash";
import type { FundingProgressSnapshot } from "./progress";
import type { FundingTopUp } from "./top-ups";

/** The durable request record as the adapters read it. */
export interface FundingTopUpRecord {
  amountHuman: string;
  startedAt: number;
  chain?: string;
  asset?: string;
  depositAddress?: string;
  tradeN?: number;
  /** The session's source id. */
  sourceId?: string;
  /** What the buyer pays, as the rail quoted it: fiat for Meld, the source coin for crypto. */
  sourceAmount?: string;
  sourceSymbol?: string;
  /** The provider's quoted fee (Meld), in `sourceSymbol` units. */
  sourceFee?: string;
  /** The provider that priced the request ("TRANSAK"), not the aggregator in front of it. */
  sourceProvider?: string;
  /** The components of `sourceFee`, as the rail reported them. */
  sourceTransactionFee?: string;
  sourceNetworkFee?: string;
  sourcePartnerFee?: string;
  /** The funding leg's own network fee, priced by the app rather than reported by the rail. */
  sourceChainFee?: string;
  /** The PSM's fee on the mint, priced by the app; PSM tier only. */
  sourceMintFee?: string;
  /** The Meld rail's buyer country. */
  meldCountry?: string;
  /** The Meld rail's provider (Transak, Koywe, ...) and the funding request's id, which is what
   *  the journey shows as the transaction id, and the reference a failed journey shows. */
  meldServiceProvider?: string;
  meldFundingRequestId?: string;
  funded?: number;
  settledAt?: number;
  claimed?: string;
  /** Why the request failed. */
  failureReason?: string;
  /** The failed swap was refunded to the request's own key, with what came back and the
   *  transaction that returned it. */
  refunded?: boolean;
  refundAmount?: string;
  refundTxRef?: string;
  progress?: FundingProgressSnapshot;
}

/**
 * Meld spells its providers in caps — "TRANSAK", "COINBASE_PAY" — and the design draws them as
 * names. Only an all-caps value is re-cased: anything carrying a lowercase letter already arrived
 * spelled the way somebody meant it, and re-casing it would be us overruling them.
 */
function asName(provider: string): string {
  if (/[a-z]/.test(provider)) return provider;
  return provider
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter((word) => word !== "")
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * The provider the payment actually went through, ready to draw, or undefined when the record
 * cannot say.
 *
 * Meld is only the aggregator in front of Transak, Koywe and the rest, and it is the one behind it
 * that took the buyer's money — so it is the one worth naming on a receipt. The record keeps that
 * name twice, from two moments: `meldServiceProvider` off the create call, and `sourceProvider`
 * off the quote the request was priced against. The create call is the better witness, because it
 * names who was actually paid; the quote stands in when an older record kept only that.
 *
 * Undefined rather than a fallback: only the caller knows which rail it is projecting, and so
 * which aggregator to name in place of a provider it never recorded.
 */
export function providerNameOf(record: {
  meldServiceProvider?: string;
  sourceProvider?: string;
}): string | undefined {
  const provider = record.meldServiceProvider ?? record.sourceProvider;
  return provider ? asName(provider) : undefined;
}

/** The rail's persisted quote, spread onto the top-up when the record carries one. */
export function quoteOf(record: FundingTopUpRecord): Pick<FundingTopUp, "quote"> {
  return record.sourceAmount && record.sourceSymbol
    ? {
        quote: {
          amount: record.sourceAmount,
          symbol: record.sourceSymbol,
          ...(record.sourceFee ? { fee: record.sourceFee } : {}),
          ...(record.sourceProvider ? { provider: record.sourceProvider } : {}),
          // The components too: the breakdown a buyer opens from the list has no session to ask.
          ...(record.sourceTransactionFee ? { transactionFee: record.sourceTransactionFee } : {}),
          ...(record.sourceNetworkFee ? { networkFee: record.sourceNetworkFee } : {}),
          ...(record.sourcePartnerFee ? { partnerFee: record.sourcePartnerFee } : {}),
          ...(record.sourceChainFee ? { chainFee: record.sourceChainFee } : {}),
          ...(record.sourceMintFee ? { mintFee: record.sourceMintFee } : {}),
        },
      }
    : {};
}

/**
 * The rail's reference for the payment, spread onto the top-up when the record carries one.
 *
 * Read from the record rather than from whatever session happens to be live: the journey that
 * most needs the reference is the one that failed, and by the time the buyer comes back to read
 * it off the screen there may be no session left to ask.
 */
export function referenceOf(record: FundingTopUpRecord): Pick<FundingTopUp, "reference"> {
  return record.meldFundingRequestId ? { reference: record.meldFundingRequestId } : {};
}

export function creditedAmount(record: FundingTopUpRecord): string {
  if (record.claimed === undefined) return record.amountHuman;
  try {
    return fmtCash(BigInt(record.claimed));
  } catch {
    return record.amountHuman;
  }
}
