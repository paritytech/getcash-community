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
  /** The network-fee share of `sourceFee`, when the rail broke it out. */
  sourceNetworkFee?: string;
  /** The Meld rail's buyer country. */
  meldCountry?: string;
  funded?: number;
  settledAt?: number;
  claimed?: string;
  /** Why the request failed. */
  failureReason?: string;
  /** The failed swap was refunded to the request's own key. */
  refunded?: boolean;
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
        },
      }
    : {};
}

export function creditedAmount(record: FundingTopUpRecord): string {
  if (record.claimed === undefined) return record.amountHuman;
  try {
    return fmtCash(BigInt(record.claimed));
  } catch {
    return record.amountHuman;
  }
}
