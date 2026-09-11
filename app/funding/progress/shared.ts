import type { FundingStep } from "@getsome/funding";
import type { FundingProgressObservation, FundingProgressSharedDefinition } from "./types";

const MINUTE = 60_000;

export const sharedCashProgress = {
  stages: [
    {
      key: "cash-conversion",
      nodeLabel: "Converted",
      activeLabel: "Converting to $CASH",
      nominalMs: 3 * MINUTE,
    },
    {
      key: "cash-teleport",
      nodeLabel: "Teleported",
      activeLabel: "Teleporting $CASH",
      nominalMs: 5 * MINUTE,
    },
    {
      key: "cash-top-up",
      nodeLabel: "Added",
      activeLabel: "Adding to your balance",
      nominalMs: MINUTE,
    },
  ],
} as const satisfies FundingProgressSharedDefinition;

export type SharedCashProgressStatus = FundingStep | "funded" | "working";

export function observeSharedCashProgress(
  status: SharedCashProgressStatus,
): FundingProgressObservation {
  switch (status) {
    case "swap":
      return { kind: "stage", stageKey: "cash-conversion" };
    case "xcm":
    case "await-arrival":
      return { kind: "stage", stageKey: "cash-teleport" };
    case "done":
    case "funded":
    case "working":
      return { kind: "stage", stageKey: "cash-top-up" };
    default:
      return { kind: "hold" };
  }
}
