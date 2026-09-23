import type { FundingTopUpState } from "./top-ups";

export type FundingHistoryReturnScreen = "pending" | "amount";
export type FundingShellScreen = FundingHistoryReturnScreen | "history";
export type FundingShellEntryScreen = FundingShellScreen | "auto";

export type FundingTopUpReturnTarget =
  { screen: "pending" } | { screen: "history"; historyReturn: FundingHistoryReturnScreen };

/** Where opening a top-up lands: the package's screen while the deposit is still to be sent,
 *  the shell's journey once it is confirmed, finished, or failed. */
export type FundingTopUpDestination = "package" | "journey";

export function resolveFundingTopUpDestination(state: FundingTopUpState): FundingTopUpDestination {
  return state.kind === "awaiting-transfer" ? "package" : "journey";
}

/**
 * Where the shell lands. The design titles the top-ups screen "Top-up in progress", so it is only
 * ever entered with one running: a settled top-up is history, and the amount screen's clock is the
 * way to it. That holds for a launch ("auto") and for a return from a journey or from history
 * ("pending") alike — the buyer whose last top-up just landed gets the input screen back, not a
 * list titled for work that has finished.
 */
export function resolveFundingShellScreen(
  requested: FundingShellEntryScreen,
  hasTopUpInProgress: boolean,
): FundingShellScreen {
  if (requested === "pending" || requested === "auto")
    return hasTopUpInProgress ? "pending" : "amount";
  return requested;
}
