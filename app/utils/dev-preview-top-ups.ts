// The preview deck's top-ups scene. Every row it shows is a record's projection: a running top-up
// is seeded into the store, so opening it opens the request; a finished one is projected from a
// record kept out of the store, so its journey has only the row to read, as one opened from
// history does. See `topUpList` in `dev-preview`.

import { shallowRef } from "vue";
import type { FundingShellEntryScreen } from "../funding/navigation";
import type { FundingRoute } from "../funding/selection";
import type { FundingTopUp } from "../funding/top-ups";

export interface PreviewTopUpScene {
  /** Rows the scene supplies itself, listed alongside whatever the adapters project from the
   *  records it seeded. Finished top-ups only; see this module's header. */
  topUps?: readonly FundingTopUp[];
  /** Draw the screen's loading placeholder instead of the cards. */
  skeleton?: boolean;
  /**
   * Where the shell enters. The keyboard deck sends itself straight to the list ("pending"); the
   * launch simulation leaves it on "auto" so the real entry rule decides, which is the whole
   * point of that scenario.
   */
  entry?: FundingShellEntryScreen;
  /** The list's own error line, as a failed open would leave it. */
  error?: string;
}

/**
 * Non-null only while a top-ups preview scene is on screen; the shell reads its cards instead of
 * the adapters'. Always null in a production build — `dev-preview` and the `?preview=top-ups`
 * launch flag are its only writers, and both are gated on `isDemoBuild()`.
 */
export const previewTopUpScene = shallowRef<PreviewTopUpScene | null>(null);

/**
 * A plausible quote for the budget, so every preview card's detail has its Fees and Total rows.
 * The real records always carry one — `quoteOf` reads it off the persisted request — so a card
 * without it would be a mock artefact, not a state worth styling. The records the scenes build
 * persist these same figures.
 */
export function previewQuote(route: FundingRoute, amount: string): FundingTopUp["quote"] {
  const cash = Number(amount.replace(/,/g, ""));
  if (!Number.isFinite(cash) || cash <= 0) return undefined;
  // The crypto rail quotes the source coin; the fiat rails quote the charge, fee included.
  if (route === "crypto") return { amount: (cash * 0.000009).toFixed(8), symbol: "BTC" };
  // The fiat split as the design frames show it: about 1.1% of the charge, most of it the
  // provider's. Carried in full because the fee row drills into the breakdown, which itemizes it.
  const transactionFee = cash * 0.0084;
  const networkFee = cash * 0.0018;
  const partnerFee = cash * 0.0008;
  const fee = transactionFee + networkFee + partnerFee;
  return {
    amount: (cash + fee).toFixed(2),
    symbol: "EUR",
    fee: fee.toFixed(2),
    transactionFee: transactionFee.toFixed(2),
    networkFee: networkFee.toFixed(2),
    partnerFee: partnerFee.toFixed(2),
  };
}
