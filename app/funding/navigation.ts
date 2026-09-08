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

export function resolveFundingShellScreen(
  requested: FundingShellEntryScreen,
  hasPendingContent: boolean,
): FundingShellScreen {
  if (requested === "pending") return hasPendingContent ? "pending" : "amount";
  return requested === "auto" ? "amount" : requested;
}
