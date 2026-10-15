// The withdrawal's timeline as the designer drew it: the top-up's seven milestones on the same
// 370 px card, with Started, Converted and Sent named. Converted reads Received once the rail has
// sent on, as the frames have it.

import type { TimelineSpec } from "../../funding/timeline/types";

export const WITHDRAWAL_MILESTONES = [
  /** The CASH reached the key. */
  "started",
  /** The conversion on the key is done. */
  "converted",
  /** The funds reached Asset Hub. */
  "moved",
  /** The key paid the rail: the provider's channel or deposit address. */
  "handed",
  /** The rail is sending on: the swap is done, the payout approved. */
  "processed",
  /** The rail sent, and the funds are on their way to the destination. */
  "dispatched",
  /** The funds are where the user asked. */
  "sent",
] as const;

export type WithdrawalMilestone = (typeof WITHDRAWAL_MILESTONES)[number];

/** The index of a withdrawal milestone. */
export const WITHDRAWAL_MILESTONE_INDEX = Object.fromEntries(
  WITHDRAWAL_MILESTONES.map((id, index) => [id, index]),
) as Readonly<Record<WithdrawalMilestone, number>>;

export const WITHDRAWAL_TIMELINE: TimelineSpec<WithdrawalMilestone> = {
  ariaLabel: "Withdrawal progress",
  failedLabel: "Failed",
  designWidth: 370,
  milestones: [
    { id: "started", label: "Started", centre: 34.5 },
    { id: "converted", centre: 77, failedLabelAlign: "start" },
    { id: "moved", centre: 141, failedLabelAlign: "end" },
    {
      id: "handed",
      label: "Converted",
      relabel: { from: WITHDRAWAL_MILESTONE_INDEX.dispatched, label: "Received" },
      centre: 187.5,
    },
    { id: "processed", centre: 234, failedLabelAlign: "start" },
    { id: "dispatched", centre: 298, failedLabelAlign: "end" },
    { id: "sent", label: "Sent", centre: 338 },
  ],
};
