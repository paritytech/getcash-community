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

/** The rail's persisted quote, spread onto the top-up when the record carries one. */
export function quoteOf(record: FundingTopUpRecord): Pick<FundingTopUp, "quote"> {
  return record.sourceAmount && record.sourceSymbol
    ? {
        quote: {
          amount: record.sourceAmount,
          symbol: record.sourceSymbol,
          ...(record.sourceFee ? { fee: record.sourceFee } : {}),
          ...(record.sourceProvider ? { provider: record.sourceProvider } : {}),
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
