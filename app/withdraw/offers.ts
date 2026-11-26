// What a withdrawal's summary shows for its fees, and whether the sale decided at confirm is
// still the one the summary showed.

import type { ConversionRoute } from "@getsome/funding";

/** The Fees drill-in behind the summary, every figure already formatted for its row. */
export interface WithdrawFeeView {
  /** The split, largest legs first; a fee the quote does not name has no row. */
  rows: { label: string; value: string }[];
  /** The sum of the split; absent when there is no split to sum. */
  total?: string;
  /** What the amount is worth before the fees ("≈ 24.75 USDC"); absent on the direct rail,
   *  whose fee is taken in CASH before the sale. */
  equivalent?: string;
  /** What lands, the same figure the summary shows. */
  receive: string;
  /** The gross rate the equivalent implies ("$1 CASH ≈ 0.99 USDC"); null when unpriceable. */
  rate: string | null;
}

/** Whether two sales are one: the same tier through the same stable and, on the PSM, at the same
 *  fee rate, which is frozen on the sale. */
export function sameSale(a: ConversionRoute, b: ConversionRoute): boolean {
  switch (a.tier) {
    case "psm":
      return b.tier === "psm" && b.external === a.external && b.feeRate === a.feeRate;
    case "pool":
      return b.tier === "pool" && b.external === a.external;
    case "dotusd":
      return b.tier === "dotusd";
  }
}
