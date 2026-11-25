// The pickers' wording: the line under a row that cannot take the amount on screen, and the
// token picker's two labelled groups. Pure, so every picker shares one wording.

import { CASH_DECIMALS } from "@getsome/people";
import { isPickable, type TokenOffer, type TokenRow } from "../stores/offers";
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
