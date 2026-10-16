// A failed withdrawal as the journey words it: the text under the timeline and the way on.

import type { WithdrawalRecord } from "../../funding/requests/model";
import { withdrawalFailureText } from "../failure-copy";
import { CANCELLED_TEXT } from "./texts";

export type WithdrawalFailureAction = "return-funds" | "try-again" | "close";

export interface WithdrawalTimelineFailure {
  readonly text: string;
  readonly action: WithdrawalFailureAction;
}

const UNKNOWN_TEXT = "Something went wrong with this withdrawal.";

/** A refund leaves the DOT on the withdrawal's own key: the design walks it into a wallet.
 *  Only the crypto route mounts that walk-through. */
export const refundedToKey = (record: WithdrawalRecord): boolean =>
  record.route === "crypto" &&
  record.status.kind === "failed" &&
  record.failure?.kind === "refunded";

export function withdrawalTimelineFailure(record: WithdrawalRecord): WithdrawalTimelineFailure {
  const { status, failure } = record;
  const text =
    status.kind === "cancelled"
      ? CANCELLED_TEXT
      : failure === undefined
        ? UNKNOWN_TEXT
        : withdrawalFailureText(failure, record.route);
  if (refundedToKey(record)) return { text, action: "return-funds" };
  if (status.kind === "failed" && status.recoverable) return { text, action: "try-again" };
  return { text, action: "close" };
}
