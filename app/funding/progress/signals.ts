import type { PaymentState } from "@getsome/core";
import type { FundingStep } from "@getsome/funding";
import { observeSharedCashProgress } from "./shared";
import type { FundingProgressProvider, FundingProgressSignal } from "./types";

export function fundingProgressSignalForPaymentState(
  provider: FundingProgressProvider,
  state: PaymentState,
): FundingProgressSignal | null {
  switch (state.phase) {
    case "awaiting-deposit":
      return {
        observation: provider.observeRoute("waiting"),
        routeStatus: "waiting",
      };
    case "swapping":
      return {
        observation: provider.observeRoute(state.swap),
        routeStatus: state.swap,
      };
    case "funded":
    case "working":
      return { observation: observeSharedCashProgress(state.phase) };
    case "failed":
      return { observation: { kind: "failed" } };
    case "done":
      return { observation: { kind: "settled" } };
    default:
      return null;
  }
}

export function fundingProgressSignalForSharedStep(step: FundingStep): FundingProgressSignal {
  return { observation: observeSharedCashProgress(step) };
}
