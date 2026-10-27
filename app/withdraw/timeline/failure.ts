// A failed withdrawal as the journey words it: the text under the timeline and the way on.

import { TOKENS, type TokenSpec } from "@getsome/core";
import { depositTokenOf, recordedRoute } from "@getsome/funding";
import { sellAmountOf } from "@getsome/meld";
import type { WithdrawalRecord } from "../../funding/requests/model";
import { withdrawalFailureText } from "../failure-copy";
import { CANCELLED_TEXT } from "./texts";

export type WithdrawalFailureAction = "return-funds" | "try-again" | "close";

export interface WithdrawalTimelineFailure {
  readonly text: string;
  readonly action: WithdrawalFailureAction;
}

const UNKNOWN_TEXT = "Something went wrong with this withdrawal.";

/** A refund leaves the DOT on a crypto withdrawal's own key: the design walks it into a wallet. */
export const refundedToKey = (record: WithdrawalRecord): boolean =>
  record.route === "crypto" &&
  record.status.kind === "failed" &&
  record.failure?.kind === "refunded";

/** The token a sale's key holds, what its redeem delivered, a lane sale's own asset never. */
export const saleTokenOnKey = (record: WithdrawalRecord): TokenSpec =>
  depositTokenOf(recordedRoute(record.handoff));

/** A sale whose own key holds funds nothing will move on its own. */
function saleFundsOnKey(record: WithdrawalRecord): boolean {
  const { sale, residue, status, failure } = record;
  if (sale === undefined) return false;
  // Funds held by a proxy are not on the key, only what the key itself holds counts
  if (residue?.stuck === true && residue.onProxy !== true) return true;
  if (residue !== undefined) {
    return (
      !residue.returning &&
      residue.amount !== undefined &&
      sellAmountOf(BigInt(residue.amount), saleTokenOnKey(record)) > 0n
    );
  }
  if (status.kind !== "failed" || failure === undefined) return false;
  return failure.kind === "unresolved" || failure.kind === "too-small";
}

/** Funds sit on the withdrawal's own key and the return-funds guide hands over its key. */
export const fundsOnKey = (record: WithdrawalRecord): boolean =>
  refundedToKey(record) || saleFundsOnKey(record);

/** What sits on a sale's key: CASH when too small to redeem, what the redeem delivered otherwise. */
export function saleAssetOnKey(record: WithdrawalRecord): string | null {
  if (record.sale === undefined) return null;
  return record.failure?.kind === "too-small" ? TOKENS.CASH.symbol : saleTokenOnKey(record).symbol;
}

export function withdrawalTimelineFailure(record: WithdrawalRecord): WithdrawalTimelineFailure {
  const { status, failure } = record;
  const text =
    status.kind === "cancelled"
      ? CANCELLED_TEXT
      : failure === undefined
        ? UNKNOWN_TEXT
        : withdrawalFailureText(failure, record.route);
  if (fundsOnKey(record)) return { text, action: "return-funds" };
  if (status.kind === "failed" && status.recoverable) return { text, action: "try-again" };
  return { text, action: "close" };
}
