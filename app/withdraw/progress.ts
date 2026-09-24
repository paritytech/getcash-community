// The withdrawal's journey as the progress ribbon shows it: Started, Conversion, Sent. Read from
// the record's status each time rather than kept on the record, since the status is the truth and
// its stamps are the milestones. A direct destination is sent by the XCM itself; a Chainflip one
// waits on the rail after the conversion.

import {
  composeFundingProgressProfile,
  createFundingProgressSnapshot,
  projectFundingProgress,
  type FundingProgressProfile,
  type FundingProgressProjection,
  type FundingProgressRouteDefinition,
  type FundingProgressSnapshotOptions,
} from "../funding/progress";
import { currencyConfig } from "../funding/config";
import {
  withdrawalRankOf,
  type WithdrawalRailState,
  type WithdrawalRecord,
} from "../funding/requests/model";

const MINUTE = 60_000;

export const WITHDRAWAL_JOURNEY_LABELS: readonly string[] = ["Started", "Conversion", "Sent"];

const CONVERSION = "withdraw-conversion";
const SENDING = "withdraw-sending";

const route = {
  id: "withdrawal",
  version: 1,
  expectedUserDelayMs: 2 * MINUTE,
  cadenceMs: 5_000,
  startedNodeLabel: "Started",
  waitingLabel: "Waiting for your payment",
  routeCompletedLabel: "Converted",
  settledLabel: "Sent",
  stages: [
    {
      key: CONVERSION,
      nodeLabel: "Conversion",
      activeLabel: `Converting your ${currencyConfig.name}`,
      nominalMs: 3 * MINUTE,
    },
  ],
  // The record's status drives the projection; no rail status is observed here.
  observe: () => ({ kind: "hold" }),
} as const satisfies FundingProgressRouteDefinition;

function sendingStage(nominalMs: number) {
  return {
    stages: [
      { key: SENDING, nodeLabel: "Sent", activeLabel: "Sending to your address", nominalMs },
    ],
  };
}

const PROFILES: Record<WithdrawalRailState["provider"], FundingProgressProfile> = {
  direct: composeFundingProgressProfile(route, sendingStage(MINUTE)),
  chainflip: composeFundingProgressProfile(route, sendingStage(20 * MINUTE)),
};

export const withdrawalProgressProfile = (rail: WithdrawalRailState["provider"]) => PROFILES[rail];

/** The snapshot the status stands for. The current status's stamp is the milestone: the stage
 *  starts when the record reached it. */
function snapshotOptions(record: WithdrawalRecord): FundingProgressSnapshotOptions {
  const { status } = record;
  switch (status.kind) {
    case "awaiting-payment":
      return { preDetectionEstimateText: "≈5 min after you pay" };
    case "paid":
    case "converting":
      return {
        detectedAt: status.at,
        confirmedStageKey: CONVERSION,
        stageTimestamps: { [CONVERSION]: status.at },
      };
    case "sending":
      return {
        detectedAt: status.at,
        confirmedStageKey: SENDING,
        stageTimestamps: { [SENDING]: status.at },
      };
    case "sent":
      return {
        detectedAt: status.at,
        confirmedStageKey: SENDING,
        stageTimestamps: { [SENDING]: status.at },
        settledAt: status.at,
      };
    case "failed":
    case "expired":
    case "cancelled": {
      const step = record.failure?.step;
      if (step === "convert" || step === "send") {
        const key = step === "convert" ? CONVERSION : SENDING;
        return {
          failedAt: status.at,
          detectedAt: status.at,
          confirmedStageKey: key,
          stageTimestamps: { [key]: status.at },
        };
      }
      return { failedAt: status.at };
    }
  }
}

export function withdrawalProgress(
  record: WithdrawalRecord,
  now: number,
): FundingProgressProjection {
  const snapshot = createFundingProgressSnapshot(
    withdrawalProgressProfile(record.rail.provider),
    snapshotOptions(record),
  );
  return projectFundingProgress({ snapshot, createdAt: record.startedAt, now });
}

/** How many of the journey's three markers are complete, 0..3. Started: the payment reached the
 *  key. Conversion: the PAS reached Asset Hub. Sent: the request is complete. A side exit reports
 *  the leg it left. */
export function withdrawalJourneyDone(record: WithdrawalRecord): number {
  const { status } = record;
  if (status.kind === "sent") return 3;
  if (status.kind === "sending") return 2;
  if (status.kind === "paid" || status.kind === "converting") return 1;
  if (status.kind === "awaiting-payment") return 0;
  const rank = withdrawalRankOf(record);
  return rank >= 3 ? 2 : rank >= 1 ? 1 : 0;
}
