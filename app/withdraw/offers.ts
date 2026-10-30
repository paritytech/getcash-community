// What each provider destination offers for the amount on screen, and how a picker row reads it.
// The amount is known before any destination is picked, so every Chainflip destination is quoted
// for it once, on the first sale the chain ranks that Chainflip accepts: the quote says whether
// the destination answers at all, whether the amount is under the provider's minimum, and what
// would land. A row is greyed with the reason; the confirm quotes the picked destination again
// before the channel is opened. A row still being quoted is not drawn at all: the picker shows a
// skeleton row in its place. Asset Hub itself has no provider: the direct rail is always pickable.

import type { ConversionRoute } from "@getsome/funding";
import { minimumLine } from "../funding/source-groups";
import type { WithdrawDestination } from "./destinations";

/** The Fees drill-in behind the summary, every figure already formatted for its row. */
export interface WithdrawFeeView {
  /** The split, largest legs first; a fee the quote does not name has no row. */
  rows: { label: string; value: string }[];
  /** The sum of the split; absent when there is no split to sum. */
  total?: string;
  /** What the amount is worth before the fees ("≈ 24.75 USDC"); absent on the direct rail,
   *  whose fee is taken in CASH before the sale. */
  equivalent?: string;
  /** What lands, the same figure the summary shows. */
  receive: string;
  /** The gross rate the equivalent implies ("$1 CASH ≈ 0.99 USDC"); null when unpriceable. */
  rate: string | null;
}

export type WithdrawOffer =
  /** Still being quoted. */
  | { state: "checking" }
  /** This build does not move money through a provider yet. */
  | { state: "rail-off" }
  /** The provider did not answer, or refused the pair; `reason` is for logs. */
  | { state: "unavailable"; reason: string }
  /** Under the provider's minimum on every sale; `minimumCash` is the smallest withdrawal it
   *  takes. */
  | { state: "too-small"; minimumCash: bigint }
  /** What lands on the destination, in its asset's base units, and formatted for the summary.
   *  `sale` is the sale picked for it and `sellable` what the quote was asked for in the sale's
   *  token, which the channel is opened for at confirm. `fees` is the quote's own split, absent
   *  when a fee could not be priced. */
  | {
      state: "available";
      sale: ConversionRoute;
      sellable: bigint;
      egress: bigint;
      formatted: string;
      etaSeconds: number | null;
      fees?: WithdrawFeeView;
    };

/** Whether two sales are one: the same tier through the same stable and, on the PSM, at the same
 *  fee rate, which is frozen on the sale. */
export function sameSale(a: ConversionRoute, b: ConversionRoute): boolean {
  switch (a.tier) {
    case "psm":
      return b.tier === "psm" && b.external === a.external && b.feeRate === a.feeRate;
    case "pool":
      return b.tier === "pool" && b.external === a.external;
    case "dotusd":
      return b.tier === "dotusd";
  }
}

export interface RowState {
  pickable: boolean;
  /** Why the row cannot be picked; nothing when it can. */
  subtitle?: string;
}

const PICKABLE: RowState = { pickable: true };

/** One destination's row, worded for the picker it sits on: a token row on the token picker, or
 *  the network row that stands for it. Nothing is pickable until its quote is in: money is at
 *  stake, so the rows wait rather than guess. */
export function rowState(
  destination: WithdrawDestination,
  offer: WithdrawOffer,
  of: "token" | "network" = "token",
): RowState {
  if (destination.rail === "direct") return PICKABLE;
  switch (offer.state) {
    case "checking":
      return { pickable: false };
    case "rail-off":
      return { pickable: false, subtitle: "Not available yet" };
    case "unavailable":
      return { pickable: false, subtitle: "Not available right now" };
    case "too-small":
      // The minimum is on the token sold, whatever it buys, so a network's row carries its tokens'.
      return { pickable: false, subtitle: minimumLine(of, offer.minimumCash) };
    case "available":
      return PICKABLE;
  }
}

/** A network is pickable when one of its tokens is; otherwise it says what its first token says,
 *  which is what they all say when the provider is not answering or the amount is too small. */
export function networkRow(rows: readonly RowState[]): RowState {
  return rows.find((row) => row.pickable) ?? rows[0] ?? { pickable: false };
}
