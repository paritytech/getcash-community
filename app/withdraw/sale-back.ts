// What a fiat sale is expected to send back to the balance, as the quote words it.

import { CASH_DECIMALS } from "@getsome/people";
import { cashAmount, fmtCashDisplay } from "../utils/cash";

/** CASH base units in a cent: what comes back is shown to the cent, rounded down. */
const CENT = 10n ** BigInt(CASH_DECIMALS - 2);

/** The CASH a sale is expected to send back, to the cent and rounded down, with its ticker; null
 *  when less than a cent comes back. */
export function backCashText(backCash: bigint): string | null {
  const cents = (backCash / CENT) * CENT;
  return cents > 0n ? cashAmount(fmtCashDisplay(cents)) : null;
}
