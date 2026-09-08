// The Meld fiat rail (card / bank) as progress: one route stage, the provider confirming the
// payment, then the shared CASH stages. Unknown statuses hold.

import { createFundingProgressProvider } from "./registry";
import { sharedCashProgress } from "./shared";
import type { FundingProgressObservation, FundingProgressRouteDefinition } from "./types";

const MINUTE = 60_000;

export const MELD_PAYMENT_STAGE = "meld-payment";

export function observeMeldProgress(status: string): FundingProgressObservation {
  switch (status) {
    case "waiting":
      return { kind: "waiting" };
    case "receiving":
      return { kind: "stage", stageKey: MELD_PAYMENT_STAGE };
    case "complete":
      return { kind: "route-complete" };
    default:
      return { kind: "hold" };
  }
}

export const meldProgressRoute = {
  id: "meld",
  version: 1,
  // How long a buyer typically takes inside the widget before the provider sees a payment.
  expectedUserDelayMs: 10 * MINUTE,
  cadenceMs: 5_000,
  startedNodeLabel: "Payment started",
  waitingLabel: "Waiting for your payment",
  routeCompletedLabel: "Payment confirmed",
  stages: [
    {
      key: MELD_PAYMENT_STAGE,
      nodeLabel: "Paid",
      activeLabel: "Confirming your payment",
      nominalMs: 5 * MINUTE,
    },
  ],
  observe: observeMeldProgress,
} as const satisfies FundingProgressRouteDefinition;

export const meldProgressProvider = createFundingProgressProvider(
  meldProgressRoute,
  sharedCashProgress,
);
