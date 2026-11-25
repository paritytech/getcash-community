// The pickers' wording for an amount under a provider's minimum. Pure, so every picker shares one
// wording.

import { CASH_DECIMALS } from "@getsome/people";
import { cashAmount } from "../utils/cash";

const CASH_BASE = 10n ** BigInt(CASH_DECIMALS);

/** Whole CASH, rounded up: a minimum is never understated. */
export const wholeCashCeil = (base: bigint): string =>
  ((base + CASH_BASE - 1n) / CASH_BASE).toString();

/** The line under a row whose amount is under a provider's minimum, the same on every picker:
 *  "Minimum for this network is $80 CASH". */
export const minimumLine = (of: "token" | "network", base: bigint): string =>
  `Minimum for this ${of} is ${cashAmount(wholeCashCeil(base))}`;
