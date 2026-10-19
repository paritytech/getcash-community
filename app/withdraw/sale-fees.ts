// The fee breakdown behind a sale's receive row, read from the sale as the record committed it.
// The live quote prices the current input and is empty while it refreshes, so a journey never
// reads it: what the breakdown says must be what the row above it promised.

import type { MeldSale } from "../funding/requests/model";

/** What the fee breakdown shows of a sale: the payout currency, the provider's line, and the CASH
 *  that comes back once the provider is paid, which the rate needs and only a live quote knows. */
export interface SaleFeeDetails {
  readonly fiat: string;
  readonly line: {
    /** The fiat that reaches the seller, decimal text in `fiat`. */
    readonly destinationAmount: string;
    readonly totalFee?: string;
    readonly transactionFee?: string;
    readonly networkFee?: string;
    readonly partnerFee?: string;
  };
  /** Planck. */
  readonly backCash?: bigint;
}

export function saleFeeDetails({ fiat, quotedPayout, fees }: MeldSale): SaleFeeDetails {
  return {
    fiat,
    line: {
      destinationAmount: quotedPayout,
      ...(fees?.total === undefined ? {} : { totalFee: fees.total }),
      ...(fees?.transaction === undefined ? {} : { transactionFee: fees.transaction }),
      ...(fees?.network === undefined ? {} : { networkFee: fees.network }),
      ...(fees?.partner === undefined ? {} : { partnerFee: fees.partner }),
    },
  };
}
