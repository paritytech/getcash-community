// The token Meld delivers to the burner and the unit helpers over it, shared by the quote and
// deposit steps. Everything here reads decimals and names off one TokenSpec, so the amount Meld is
// asked for and the amount the app sizes and formats cannot disagree about which asset that is.
// The fiat side is carried separately in Quote.raw.

import type { TokenSpec } from "@getsome/core";

/**
 * A token Meld can deliver: it must have a Meld currency code for the wire, and the Chainflip
 * identifier the rail port's SourceDescriptor and Quote name delivered assets by.
 */
export type MeldToken = TokenSpec &
  Required<Pick<TokenSpec, "chainflipAsset" | "meldCurrencyCode">>;

/** Ceil-normalize a reverse-quote target to `token` base units (never under-target). */
export function toBaseUnits(
  token: TokenSpec,
  target: { amount: bigint; decimals: number },
): bigint {
  if (target.decimals === token.decimals) return target.amount;
  if (target.decimals < token.decimals) {
    return target.amount * 10n ** BigInt(token.decimals - target.decimals);
  }
  const scale = 10n ** BigInt(target.decimals - token.decimals);
  return (target.amount + scale - 1n) / scale;
}

/** `token` base units to a whole-token decimal string, trailing zeros trimmed. */
export function formatBaseUnits(token: TokenSpec, base: bigint): string {
  const s = base.toString().padStart(token.decimals + 1, "0");
  const out = `${s.slice(0, -token.decimals)}.${s.slice(-token.decimals)}`.replace(/\.?0+$/, "");
  return out === "" ? "0" : out;
}
