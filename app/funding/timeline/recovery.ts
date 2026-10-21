// A top-up whose Cash is in People's trap, as the journey words it: the band's text and the ways
// to pay the claim's fee. The milestone carries no label of its own; the amber line and the band
// say what is happening, and the buttons say what the buyer can do.

import { cashInText, fmtCash } from "../../utils/cash";
import { paymentOutOfRound, type TopUpRecord } from "../requests/model";
import { delay, type TimelineMessage } from "./route";

/** A way to pay the claim's fee: from the purse, through the host's sheet, or by sending a
 *  token to the top-up's own account. */
export type RecoveryAction =
  { readonly kind: "from-balance"; readonly retry: boolean } | { readonly kind: "send-deposit" };

export const FROM_BALANCE: RecoveryAction = { kind: "from-balance", retry: false };
export const FROM_BALANCE_AGAIN: RecoveryAction = { kind: "from-balance", retry: true };
export const SEND_DEPOSIT: RecoveryAction = { kind: "send-deposit" };

export interface RecoveryPrompt {
  readonly message: TimelineMessage;
  readonly detail: string;
  /** The first is the main one; none while nothing is asked of the buyer. */
  readonly actions: readonly RecoveryAction[];
}

const STUCK = "Your Cash got stuck on the way to your balance.";
const RECOVERING = "Recovering your Cash";

/** The claim's fee as the band names it, when the worker has sized it. */
function feeText(record: TopUpRecord): string | undefined {
  const fee = record.recovery?.askCash;
  return fee === undefined ? undefined : cashInText(fmtCash(BigInt(fee)));
}

/** What the journey says and offers for a top-up in recovery; absent for any other. */
export function recoveryPrompt(record: TopUpRecord): RecoveryPrompt | undefined {
  const { status, recovery } = record;
  if (status.kind !== "recovering") return undefined;
  if (status.step === "claiming") {
    return {
      message: delay(RECOVERING),
      detail: "It will be added to your balance in a moment.",
      actions: [],
    };
  }
  const payment = recovery?.payment;
  // A deposit on the top-up's own account is being converted for the fee.
  if (recovery?.deposit !== undefined && recovery.deposit !== "await-native") {
    return {
      message: delay(RECOVERING),
      detail: "Converting what you sent to cover the fee.",
      actions: [],
    };
  }
  const fee = feeText(record);
  // Nothing is offered before the worker has sized the fee: the first recovery tick does.
  if (fee === undefined || recovery === undefined) {
    return { message: delay(STUCK), detail: "Working out the recovery fee.", actions: [] };
  }
  // The worker moved past the round the purse paid in: a claim spent the fee, or it grew.
  if (paymentOutOfRound(recovery)) {
    return {
      message: delay("The claim didn't go through."),
      detail: `Another ${fee} is needed. Pay it from your balance, or send a small deposit instead.`,
      actions: [FROM_BALANCE_AGAIN, SEND_DEPOSIT],
    };
  }
  if (
    payment?.requestedAt !== undefined &&
    payment.status !== "failed" &&
    payment.status !== "not-found"
  ) {
    return {
      message: delay(RECOVERING),
      detail: "The fee is on its way from your balance.",
      actions: [],
    };
  }
  if (payment?.status === "failed") {
    if (payment.refusal === "insufficient-balance") {
      return {
        message: delay("Your balance couldn't cover the recovery fee."),
        detail:
          "Send a small deposit to this top-up's address to cover it, or try again once you have Cash.",
        actions: [SEND_DEPOSIT, FROM_BALANCE_AGAIN],
      };
    }
    return {
      message: delay(
        payment.refusal === "declined"
          ? "You declined the fee payment."
          : "The fee couldn't be paid from your balance.",
      ),
      detail: "Try again, or send a small deposit to this top-up's address instead.",
      actions: [FROM_BALANCE_AGAIN, SEND_DEPOSIT],
    };
  }
  // Never asked, or asked of a host that turned out not to know the payment.
  return {
    message: delay(STUCK),
    detail: `Pay the ${fee} recovery fee from your balance to get it back.`,
    actions: [FROM_BALANCE, SEND_DEPOSIT],
  };
}

/** The list row's word on a top-up in recovery. */
export function recoveryHeadline(prompt: RecoveryPrompt): string {
  return prompt.actions.length > 0 ? "Needs a step from you" : RECOVERING;
}
