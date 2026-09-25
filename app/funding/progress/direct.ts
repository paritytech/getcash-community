// A direct deposit on Asset Hub as progress: one route stage, the transfer confirming, then the
// shared CASH stages. The manual rail reports no status of its own, so a sighting of the burner
// completes the stage in one step; unknown statuses hold.

import { createFundingProgressProvider } from "./registry";
import { sharedCashProgress } from "./shared";
import type { FundingProgressObservation, FundingProgressRouteDefinition } from "./types";

const MINUTE = 60_000;

export const DIRECT_DEPOSIT_STAGE = "direct-confirming";

export function observeDirectProgress(status: string): FundingProgressObservation {
  switch (status) {
    case "waiting":
      return { kind: "waiting" };
    case "receiving":
      return { kind: "stage", stageKey: DIRECT_DEPOSIT_STAGE };
    case "complete":
      return { kind: "route-complete" };
    default:
      return { kind: "hold" };
  }
}

export const directProgressRoute = {
  id: "direct",
  version: 1,
  // How long a buyer typically takes to send from their wallet.
  expectedUserDelayMs: 10 * MINUTE,
  cadenceMs: 5_000,
  startedNodeLabel: "Payment seen",
  stages: [
    {
      key: DIRECT_DEPOSIT_STAGE,
      nodeLabel: "Confirmed",
      activeLabel: "Confirming your transfer",
      nominalMs: 2 * MINUTE,
    },
  ],
  observe: observeDirectProgress,
} as const satisfies FundingProgressRouteDefinition;

export const directProgressProvider = createFundingProgressProvider(
  directProgressRoute,
  sharedCashProgress,
);
