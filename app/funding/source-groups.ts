// The deposit pickers' wording: the line under a row that cannot take the amount on screen, and
// the token picker's two labelled groups. The network picker's order is OptionList's. Pure, so
// both screens share one wording.

import { CASH_DECIMALS } from "@getsome/people";
import { isPickable, type NetworkRow, type TokenOffer, type TokenRow } from "../stores/offers";
import { cashAmount } from "../utils/cash";

export interface PickerGroup<T> {
  label: string;
  rows: T[];
}

const CASH_BASE = 10n ** BigInt(CASH_DECIMALS);

/** Whole CASH, rounded up: a minimum is never understated. */
export const wholeCashCeil = (base: bigint): string =>
  ((base + CASH_BASE - 1n) / CASH_BASE).toString();

/** The line under a row whose amount is under a provider's minimum, the same on every picker:
 *  "Minimum for this network is $80 CASH". */
export const minimumLine = (of: "token" | "network", base: bigint): string =>
  `Minimum for this ${of} is ${cashAmount(wholeCashCeil(base))}`;

/** The smallest purchase any of these tokens would take, in CASH base units; null when none
 *  reported one. */
export function smallestMinimumCash(tokens: readonly { offer: TokenOffer }[]): bigint | null {
  let smallest: bigint | null = null;
  for (const { offer } of tokens) {
    if (offer.state !== "too-small" || offer.minimumCashBase === null) continue;
    if (smallest === null || offer.minimumCashBase < smallest) smallest = offer.minimumCashBase;
  }
  return smallest;
}

/** The line under a token row: why it cannot be picked, nothing when it can. A token still being
 *  answered says nothing either, since the picker draws a skeleton row in its place. */
export function tokenSubtitle(offer: TokenOffer): string | undefined {
  switch (offer.state) {
    case "rail-off":
      return "Not available yet";
    case "unavailable":
      return "Not available right now";
    case "too-small":
      return offer.minimumCashBase === null
        ? "Amount too small"
        : minimumLine("token", offer.minimumCashBase);
    case "available":
    case "ungated":
    case "direct":
    case "checking":
      return undefined;
  }
}

/** A network that can be picked says nothing, as does one still being answered; one that cannot
 *  says why, by its tokens. */
export function networkSubtitle(network: NetworkRow): string | undefined {
  if (network.available || network.checking) return undefined;
  const states = new Set(network.tokens.map((t) => t.offer.state));
  if (states.has("rail-off")) return "Not available yet";
  const minimum = smallestMinimumCash(network.tokens);
  if (minimum !== null) return minimumLine("network", minimum);
  if (states.has("too-small")) return "Amount too small";
  return "Not available right now";
}

function split<T>(
  rows: readonly T[],
  pickable: (row: T) => boolean,
  labels: { supported: string; unsupported: string },
): PickerGroup<T>[] {
  const groups: PickerGroup<T>[] = [];
  const supported = rows.filter(pickable);
  const unsupported = rows.filter((row) => !pickable(row));
  if (supported.length > 0) groups.push({ label: labels.supported, rows: supported });
  if (unsupported.length > 0) groups.push({ label: labels.unsupported, rows: unsupported });
  return groups;
}

export const groupTokens = (tokens: readonly TokenRow[]): PickerGroup<TokenRow>[] =>
  split(tokens, (token) => isPickable(token.offer), {
    supported: "All tokens",
    unsupported: "Unsupported token",
  });
