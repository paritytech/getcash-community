// The floor under a provider withdrawal: Chainflip will not swap less than a minimum of DOT out
// of Asset Hub, and a deposit under it just sits in the channel. The amount is known before any
// route is picked, so every Chainflip row is judged against the floor there, greyed with the
// minimum in CASH as its reason, and the confirm judges once more before the channel is opened.
// Asset Hub itself has no floor: the direct rail is always pickable.

import { wholeCashCeil } from "../funding/source-groups";
import type { WithdrawDestination, WithdrawNetwork } from "./destinations";

export type WithdrawFloor =
  /** Still being learned from Chainflip. */
  | { state: "checking" }
  /** Chainflip did not answer, or lists no minimum; `reason` is for logs. */
  | { state: "unknown"; reason: string }
  /** The smallest provider withdrawal, in CASH base units, fees and headroom included. */
  | { state: "known"; minimumCash: bigint };

export interface RowState {
  pickable: boolean;
  /** Why the row cannot be picked; nothing when it can. */
  subtitle?: string;
}

const PICKABLE: RowState = { pickable: true };

/** One destination against the amount on screen. Nothing is pickable until the floor is known:
 *  money is at stake, so the rows wait rather than guess. */
export function destinationState(
  destination: WithdrawDestination,
  amountCash: bigint | null,
  floor: WithdrawFloor,
  railOn: boolean,
): RowState {
  if (destination.rail === "direct") return PICKABLE;
  if (!railOn) return { pickable: false, subtitle: "Not available yet" };
  switch (floor.state) {
    case "checking":
      return { pickable: false, subtitle: "Checking…" };
    case "unknown":
      return { pickable: false, subtitle: "Not available right now" };
    case "known":
      if (amountCash !== null && amountCash < floor.minimumCash) {
        // The same line on a network row and on its token rows: the floor is on the DOT sold,
        // whatever it buys.
        return {
          pickable: false,
          subtitle: `Minimum is ${wholeCashCeil(floor.minimumCash)} $CASH`,
        };
      }
      return PICKABLE;
  }
}

/** A network is pickable when one of its tokens is; otherwise it says what its tokens say, and
 *  they all say the same, since the floor is on the DOT sold and not on what it buys. */
export function networkState(
  network: WithdrawNetwork,
  amountCash: bigint | null,
  floor: WithdrawFloor,
  railOn: boolean,
): RowState {
  const states = network.destinations.map((d) => destinationState(d, amountCash, floor, railOn));
  return states.find((s) => s.pickable) ?? states[0] ?? { pickable: false };
}
