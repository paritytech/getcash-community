// The deposit pickers' two groups: the sources a buyer can pick for the amount on screen, then
// the ones that cannot take it, each greyed with the line that says why. The same split the
// country picker draws, so the two pickers read alike. Pure, so both screens share one wording.

import {
  isNetworkPickable,
  isPickable,
  type NetworkRow,
  type TokenOffer,
  type TokenRow,
} from "../stores/offers";
import { cashAmount } from "../utils/cash";

export interface PickerGroup<T> {
  label: string;
  rows: T[];
}

const CASH_BASE = 1_000_000n;

/** Whole CASH, rounded up: a minimum is never understated. */
export const wholeCashCeil = (base: bigint): string =>
  ((base + CASH_BASE - 1n) / CASH_BASE).toString();

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

export function tokenSubtitle(offer: TokenOffer): string | undefined {
  switch (offer.state) {
    case "checking":
      return "Checking…";
    case "rail-off":
      return "Not available yet";
    case "unavailable":
      return "Not available right now";
    case "too-small":
      return offer.minimumCashBase === null
        ? "Amount too small"
        : `Minimum for this token is ${cashAmount(wholeCashCeil(offer.minimumCashBase))}`;
    case "available":
    case "ungated":
      return undefined;
  }
}

/** A network that can be picked says nothing; one that cannot says why, by its tokens. */
export function networkSubtitle(network: NetworkRow): string | undefined {
  if (network.available) return undefined;
  if (network.checking) return "Checking…";
  const states = new Set(network.tokens.map((t) => t.offer.state));
  if (states.has("rail-off")) return "Not available yet";
  const minimum = smallestMinimumCash(network.tokens);
  if (minimum !== null) return `Minimum for this network is ${cashAmount(wholeCashCeil(minimum))}`;
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

export const groupNetworks = (networks: readonly NetworkRow[]): PickerGroup<NetworkRow>[] =>
  split(networks, isNetworkPickable, {
    supported: "All networks",
    unsupported: "Unsupported network",
  });

export const groupTokens = (tokens: readonly TokenRow[]): PickerGroup<TokenRow>[] =>
  split(tokens, (token) => isPickable(token.offer), {
    supported: "All tokens",
    unsupported: "Unsupported token",
  });
