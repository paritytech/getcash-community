// CASH amount math.

import { CASH_DECIMALS } from "@getsome/people";
import { currencyConfig } from "../funding/config";

/** Human amount -> 6-dec CASH base units. Null for invalid or zero input. */
export function toCashBase(human: string): bigint | null {
  // A locale decimal pad may yield a comma separator.
  const trimmed = human.trim().replace(",", ".");
  if (!/^\d*(\.\d*)?$/.test(trimmed) || trimmed === "" || trimmed === ".") return null;
  const [whole = "0", frac = ""] = trimmed.split(".");
  if (frac.length > CASH_DECIMALS) return null;
  const base =
    BigInt(whole) * 10n ** BigInt(CASH_DECIMALS) + BigInt(frac.padEnd(CASH_DECIMALS, "0") || "0");
  return base > 0n ? base : null;
}

/** 6-dec CASH base units -> human string, trailing zeros trimmed. */
export function fmtCash(base: bigint): string {
  const s = base.toString().padStart(CASH_DECIMALS + 1, "0");
  return `${s.slice(0, -CASH_DECIMALS)}.${s.slice(-CASH_DECIMALS)}`.replace(/\.?0+$/, "") || "0";
}

/**
 * A CASH amount as the designs write it, wherever it can only be a string: the symbol on the
 * number, the ticker beside it ("$50 CASH", "+$50 CASH"). Anywhere markup can render, use
 * `<CashAmount>` instead — it carries the same form plus the ticker's small-caps treatment.
 *
 * The bare token in prose keeps its own form — "Converting to $CASH", "Final $CASH depends on the
 * rate on arrival" — because there it is a name, not a sum.
 */
export const cashAmount = (human: string): string =>
  `${currencyConfig.symbol}${human} ${currencyConfig.ticker}`;

/** CASH base units truncated down to the keypad's `decimals` scale. */
export function cashToRuleUnits(base: bigint, decimals: number): bigint {
  const drop = CASH_DECIMALS - decimals;
  return drop >= 0 ? base / 10n ** BigInt(drop) : base * 10n ** BigInt(-drop);
}

/** Turns CASH base units into the amount string the keypad edits, rounded down to `decimals`
 *  places, with a whole number left bare ("226.78", "5", "5.5"). */
export function cashToAmountInput(base: bigint, decimals: number): string {
  const scaled = cashToRuleUnits(base, decimals);
  if (decimals === 0) return scaled.toString();
  const s = scaled.toString().padStart(decimals + 1, "0");
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, "");
}

/** 6-dec CASH base units -> a money-like string with at least two decimals ("10.00", "18.75"). */
export function fmtCashDisplay(base: bigint): string {
  const s = base.toString().padStart(CASH_DECIMALS + 1, "0");
  const whole = s.slice(0, -CASH_DECIMALS);
  const frac = s.slice(-CASH_DECIMALS).replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${frac}`;
}

/** Thousands-separated amount string ("2000" -> "2,000"), the fraction left as typed. */
export function groupAmountDigits(value: string): string {
  const [whole = "0", fraction] = value.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}
