import { CHAINFLIP_PROGRESS_STATUSES, type ChainflipProgressStatus } from "@getsome/chainflip";
import { createFundingProgressProvider } from "./registry";
import { sharedCashProgress } from "./shared";
import type { FundingProgressObservation, FundingProgressRouteDefinition } from "./types";

const MINUTE = 60_000;
const statuses = new Set<string>(CHAINFLIP_PROGRESS_STATUSES);

export function observeChainflipProgress(
  status: ChainflipProgressStatus,
): FundingProgressObservation {
  switch (status) {
    case "waiting":
      return { kind: "waiting" };
    case "receiving":
      return { kind: "stage", stageKey: "chainflip-receiving" };
    case "swapping":
      return { kind: "stage", stageKey: "chainflip-swapping" };
    case "sending":
      return { kind: "stage", stageKey: "chainflip-sending" };
    case "complete":
      return { kind: "route-complete" };
  }
}

export const chainflipProgressRoute = {
  id: "chainflip",
  version: 2,
  expectedUserDelayMs: 10 * MINUTE,
  cadenceMs: 5_000,
  startedNodeLabel: "Payment seen",
  stages: [
    {
      key: "chainflip-receiving",
      nodeLabel: "Confirmed",
      activeLabel: "Confirming your payment",
      nominalMs: 20 * MINUTE,
    },
    {
      key: "chainflip-swapping",
      nodeLabel: "Swapped",
      activeLabel: "Processing through Chainflip",
      nominalMs: 3 * MINUTE,
    },
    {
      key: "chainflip-sending",
      nodeLabel: "Sent",
      activeLabel: "Sending your payment",
      nominalMs: MINUTE,
    },
  ],
  observe(status: string): FundingProgressObservation {
    return statuses.has(status)
      ? observeChainflipProgress(status as ChainflipProgressStatus)
      : { kind: "hold" };
  },
} as const satisfies FundingProgressRouteDefinition;

export const chainflipProgressProvider = createFundingProgressProvider(
  chainflipProgressRoute,
  sharedCashProgress,
);
