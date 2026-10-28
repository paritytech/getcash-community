// The withdrawal's timeline as the designer drew it: the top-up's seven milestones on the same
// 370 px card, with Started, Received and Sent named. Everything up to Received runs on Polkadot;
// everything after it is the rail's own.

import type { TimelineSpec } from "../../funding/timeline/types";

export const WITHDRAWAL_MILESTONES = [
  /** The CASH reached the key. */
  "started",
  /** The key filed the XCM out of People. */
  "departed",
  /** The conversion on Asset Hub is done: the PSM redeem, or the pool's own program. */
  "converted",
  /** The rail has the funds: the PSM tier's separate hand-off, or the pool tier's one XCM
   *  landing there directly. */
  "received",
  /** The rail is sending on: the swap is done, the payout approved. */
  "processed",
  /** The rail sent, and the funds are on their way to the destination. */
  "dispatched",
  /** The funds are where the user asked. */
  "sent",
] as const;

export type WithdrawalMilestone = (typeof WITHDRAWAL_MILESTONES)[number];

export const WITHDRAWAL_TIMELINE: TimelineSpec<WithdrawalMilestone> = {
  ariaLabel: "Withdrawal progress",
  failedLabel: "Failed",
  designWidth: 370,
  milestones: [
    { id: "started", label: "Started", centre: 34.5 },
    { id: "departed", centre: 77 },
    { id: "converted", centre: 141 },
    { id: "received", label: "Received", centre: 187.5 },
    { id: "processed", centre: 234 },
    { id: "dispatched", centre: 298 },
    { id: "sent", label: "Sent", centre: 338 },
  ],
};
