// A failed withdrawal as the journey words it: the text under the timeline and the way on.

import type { WithdrawalRecord } from "../../funding/requests/model";
import { withdrawalFailureText } from "../failure-copy";
import { CANCELLED_TEXT } from "./texts";

export type WithdrawalFailureAction = "try-again" | "close";

export interface WithdrawalTimelineFailure {
  readonly text: string;
  readonly action: WithdrawalFailureAction;
}

const UNKNOWN_TEXT = "Something went wrong with this withdrawal.";

export function withdrawalTimelineFailure(record: WithdrawalRecord): WithdrawalTimelineFailure {
  const { status, failure } = record;
  const text =
    status.kind === "cancelled"
      ? CANCELLED_TEXT
      : failure === undefined
        ? UNKNOWN_TEXT
        : withdrawalFailureText(failure, record.route);
  if (status.kind === "failed" && status.recoverable) return { text, action: "try-again" };
  return { text, action: "close" };
}
