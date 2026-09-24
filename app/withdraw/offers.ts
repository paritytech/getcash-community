// What each provider destination offers for the amount on screen, and how a picker row reads it.
// The amount is known before any route is picked, so every Chainflip destination is quoted for
// it once: the quote says whether the route answers at all, whether the amount is under the
// provider's minimum, and what would land. A row is greyed with the reason; the confirm judges
// once more before the channel is opened. Asset Hub itself has no provider: the direct rail is
// always pickable.

import { wholeCashCeil } from "../funding/source-groups";
import { cashAmount } from "../utils/cash";
import type { WithdrawDestination } from "./destinations";

export type WithdrawOffer =
  /** Still being quoted. */
  | { state: "checking" }
  /** This build does not move money through a provider yet. */
  | { state: "rail-off" }
  /** The provider did not answer, or refused the pair; `reason` is for logs. */
  | { state: "unavailable"; reason: string }
  /** Under the provider's minimum; `minimumCash` is the smallest withdrawal it takes. */
  | { state: "too-small"; minimumCash: bigint }
  /** What lands on the destination, in its asset's base units, and formatted for the summary. */
  | { state: "available"; egress: bigint; formatted: string; etaSeconds: number | null };

export interface RowState {
  pickable: boolean;
  /** Why the row cannot be picked; nothing when it can. */
  subtitle?: string;
}

const PICKABLE: RowState = { pickable: true };

/** One destination's row. Nothing is pickable until its quote is in: money is at stake, so the
 *  rows wait rather than guess. */
export function rowState(destination: WithdrawDestination, offer: WithdrawOffer): RowState {
  if (destination.rail === "direct") return PICKABLE;
  switch (offer.state) {
    case "checking":
      return { pickable: false, subtitle: "Checking…" };
    case "rail-off":
      return { pickable: false, subtitle: "Not available yet" };
    case "unavailable":
      return { pickable: false, subtitle: "Not available right now" };
    case "too-small":
      // The same line on a network row and on its token rows: the minimum is on the DOT sold,
      // whatever it buys.
      return {
        pickable: false,
        subtitle: `Minimum is ${cashAmount(wholeCashCeil(offer.minimumCash))}`,
      };
    case "available":
      return PICKABLE;
  }
}

/** A network is pickable when one of its tokens is; otherwise it says what its first token says,
 *  which is what they all say when the provider is not answering or the amount is too small. */
export function networkRow(rows: readonly RowState[]): RowState {
  return rows.find((row) => row.pickable) ?? rows[0] ?? { pickable: false };
}
