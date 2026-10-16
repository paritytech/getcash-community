// The token Meld delivers to the burner and the unit helpers over it, shared by the quote and
// deposit steps. Everything here reads decimals and names off one TokenSpec, so the amount Meld is
// asked for and the amount the app sizes and formats cannot disagree about which asset that is.
// The fiat side is carried separately in Quote.raw.

import type { TokenSpec } from "@getsome/core";

/**
 * An asset as Meld names and sizes it: its currency code on the wire and the decimals its amounts
 * carry. A token of the table, or a lane's asset on another chain, which no TokenSpec describes.
 */
export type MeldToken = Pick<TokenSpec, "symbol" | "decimals"> &
  Required<Pick<TokenSpec, "meldCurrencyCode">>;

/** Ceil-normalize a reverse-quote target to `token` base units (never under-target). */
export function toBaseUnits(
  token: Pick<TokenSpec, "decimals">,
  target: { amount: bigint; decimals: number },
): bigint {
  if (target.decimals === token.decimals) return target.amount;
  if (target.decimals < token.decimals) {
    return target.amount * 10n ** BigInt(token.decimals - target.decimals);
  }
  const scale = 10n ** BigInt(target.decimals - token.decimals);
  return (target.amount + scale - 1n) / scale;
}

/** A whole-token decimal string in `token` base units, exactly; null for anything that is not a
 *  plain non-negative decimal or carries more significant fraction digits than the token has. */
export function parseBaseUnits(token: Pick<TokenSpec, "decimals">, text: string): bigint | null {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(text.trim());
  if (match === null) return null;
  // Trailing zeros carry no value: a provider's `23.452100000000000000` is `23.4521`.
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length > token.decimals) return null;
  return BigInt(match[1]! + fraction.padEnd(token.decimals, "0"));
}

/** `token` base units to a whole-token decimal string, trailing zeros trimmed. */
export function formatBaseUnits(token: Pick<TokenSpec, "decimals">, base: bigint): string {
  const s = base.toString().padStart(token.decimals + 1, "0");
  const out = `${s.slice(0, -token.decimals)}.${s.slice(-token.decimals)}`.replace(/\.?0+$/, "");
  return out === "" ? "0" : out;
}
