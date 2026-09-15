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
  hasTopUpInProgress = false,
): FundingShellScreen {
  if (requested === "pending") return hasPendingContent ? "pending" : "amount";
  // Launch: a top-up still running is what the buyer reopened the app for, so it owns the first
  // screen. A settled one does not — the design titles this screen "Top-up in progress".
  if (requested === "auto") return hasTopUpInProgress ? "pending" : "amount";
  return requested;
}
