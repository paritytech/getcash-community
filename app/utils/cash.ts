// CASH amount math.

import { CASH_DECIMALS } from "@getsome/people";

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

/** 6-dec CASH base units -> a money-like string with at least two decimals ("10.00", "18.75"). */
export function fmtCashDisplay(base: bigint): string {
  const s = base.toString().padStart(CASH_DECIMALS + 1, "0");
  const whole = s.slice(0, -CASH_DECIMALS);
  const frac = s.slice(-CASH_DECIMALS).replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${frac}`;
}
