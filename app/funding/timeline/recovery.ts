// A top-up whose Cash is in People's trap, as the journey words it: the band's text and the ways
// to pay the claim's fee. The milestone carries no label of its own; the amber line and the band
// say what is happening, and the buttons say what the buyer can do.

import { currencyConfig } from "../config";
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

/** What the purse holds, as the journey last read it: the balance in base units, "unknown" while
 *  it has not been read, "none" where there is no purse to read. */
export type PurseWord = bigint | "unknown" | "none";

export interface RecoveryPrompt {
  readonly message: TimelineMessage;
  readonly detail: string;
  /** The first is the main one; none while nothing is asked of the buyer. */
  readonly actions: readonly RecoveryAction[];
}

const ALMOST_HERE = "Your Cash is almost here";
const ADDING = "Adding your Cash";
const NOT_PAID = "The fee wasn't paid";
const NOT_ADDED = "We couldn't add your Cash yet";

/** The claim's fee as the band names it ("$0.01"), when the worker has sized it. */
export function recoveryFee(record: TopUpRecord): string | undefined {
  const fee = record.recovery?.askCash;
  return fee === undefined ? undefined : `${currencyConfig.symbol}${fmtCash(BigInt(fee))}`;
}

/** The Cash the claim adds, as a decimal: what the trap holds, which a swap filled off its quote
 *  leaves apart from the quoted amount; the quote until the worker found the trap. */
export function trappedCash(record: TopUpRecord): string {
  const trapped = record.recovery?.trappedAmount;
  return trapped === undefined ? record.amountHuman : fmtCash(BigInt(trapped));
}

/**
 * Whether the purse can pay the fee. A read balance decides; an unread one is taken to cover it,
 * unless the host's last word was that it did not, so a buyer whose balance was topped up since
 * is offered the purse again once the next read says so.
 */
function purseCovers(record: TopUpRecord, purse: PurseWord): boolean {
  if (purse === "none") return false;
  const fee = record.recovery?.askCash;
  if (typeof purse === "bigint") return fee !== undefined && purse >= BigInt(fee);
  return record.recovery?.payment?.refusal !== "insufficient-balance";
}

/** What the journey says and offers for a top-up in recovery; absent for any other. */
export function recoveryPrompt(
  record: TopUpRecord,
  purse: PurseWord = "unknown",
): RecoveryPrompt | undefined {
  const { status, recovery } = record;
  if (status.kind !== "recovering") return undefined;
  const cash = cashInText(trappedCash(record));
  const paid = `The fee is paid. Your ${cash} will be in your balance in a moment.`;
  if (status.step === "claiming") {
    return { message: delay(ADDING), detail: paid, actions: [] };
  }
  const payment = recovery?.payment;
  // A deposit on the top-up's own account is being converted for the fee.
  if (recovery?.deposit !== undefined && recovery.deposit !== "await-native") {
    return {
      message: delay(ADDING),
      detail: "Converting what you sent to cover the fee.",
      actions: [],
    };
  }
  const fee = recoveryFee(record);
  // Nothing is offered before the worker has sized the fee: the first recovery tick does.
  if (fee === undefined || recovery === undefined) {
    return { message: delay(ALMOST_HERE), detail: "Working out the network fee.", actions: [] };
  }
  const covers = purseCovers(record, purse);
  // The worker moved past the round the purse paid in: a claim spent the fee, or it grew.
  if (paymentOutOfRound(recovery)) {
    return {
      message: delay(NOT_ADDED),
      detail: covers
        ? `Another ${fee} network fee is needed. Pay it from your balance or from another wallet.`
        : `Another ${fee} network fee is needed. Pay it from another wallet.`,
      actions: covers ? [FROM_BALANCE, SEND_DEPOSIT] : [SEND_DEPOSIT],
    };
  }
  // The purse paid part of the fee: the worker asks for the rest.
  if (payment?.status === "partiallyClaimed") {
    return {
      message: delay(NOT_ADDED),
      detail: covers
        ? `Your balance covered part of the fee. Another ${fee} is needed. Pay it from your balance or from another wallet.`
        : `Your balance covered part of the fee. Another ${fee} is needed. Pay it from another wallet.`,
      actions: covers ? [FROM_BALANCE, SEND_DEPOSIT] : [SEND_DEPOSIT],
    };
  }
  if (
    payment?.requestedAt !== undefined &&
    payment.status !== "failed" &&
    payment.status !== "not-found"
  ) {
    // Asked and not yet answered: the sheet is up, or the answer is still to be read back.
    return payment.status === undefined
      ? { message: delay(ALMOST_HERE), detail: "Waiting for the fee to be approved.", actions: [] }
      : { message: delay(ADDING), detail: paid, actions: [] };
  }
  if (payment?.status === "failed") {
    if (!covers) {
      return {
        message: delay(NOT_PAID),
        detail:
          payment.refusal === "insufficient-balance"
            ? "Your balance couldn't cover it. Pay the fee from another wallet."
            : `Your ${cash} is still waiting. Pay the fee from another wallet.`,
        actions: [SEND_DEPOSIT],
      };
    }
    return {
      message: delay(NOT_PAID),
      detail: `Your ${cash} is still waiting. Try again, or pay from another wallet.`,
      actions: [FROM_BALANCE_AGAIN, SEND_DEPOSIT],
    };
  }
  // Never asked, or asked of a host that turned out not to know the payment.
  return covers
    ? {
        message: delay(ALMOST_HERE),
        detail: `A ${fee} network fee is needed to add it to your balance.`,
        actions: [FROM_BALANCE],
      }
    : {
        message: delay(ALMOST_HERE),
        detail: `A ${fee} network fee is needed to add it. You can pay it from another wallet.`,
        actions: [SEND_DEPOSIT],
      };
}

/** The list row's word on a top-up in recovery: that the buyer is needed, else the band's own. */
export function recoveryHeadline(prompt: RecoveryPrompt): string {
  return prompt.actions.length > 0 ? "Needs a step from you" : prompt.message.text;
}
