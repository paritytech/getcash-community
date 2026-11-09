// A top-up whose Cash is in People's trap, as the journey words it: the band's text and the ways
// to pay the claim's fee. The milestone carries no label of its own; the amber line and the band
// say what is happening, and the buttons say what the buyer can do.

import { currencyConfig } from "../config";
import { cashAmount, fmtCash, fmtCashToCents } from "../../utils/cash";
import { paymentOutOfRound, type TopUpRecord, type TopUpRecovery } from "../requests/model";
import { delay, type TimelineMessage } from "./route";

/** A way to pay the claim's fee: from the purse, through the host's sheet, or by sending a
 *  token to the top-up's own account. */
export type RecoveryAction =
  { readonly kind: "from-balance"; readonly retry: boolean } | { readonly kind: "send-deposit" };

export const FROM_BALANCE: RecoveryAction = { kind: "from-balance", retry: false };
export const FROM_BALANCE_AGAIN: RecoveryAction = { kind: "from-balance", retry: true };
export const SEND_DEPOSIT: RecoveryAction = { kind: "send-deposit" };

/** What the purse holds, as the journey last read it: the balance in base units, "unknown" while
 *  it has not been read, "unread" once its reads keep failing, "none" where there is no purse to
 *  read. */
export type PurseWord = bigint | "unknown" | "unread" | "none";

export interface RecoveryPrompt {
  readonly message: TimelineMessage;
  readonly detail: string;
  /** The first is the main one; none while nothing is asked of the buyer. */
  readonly actions: readonly RecoveryAction[];
}

const ALMOST_HERE = "Your CASH is almost here";
const ADDING = "Adding your CASH";
const NOT_PAID = "The fee wasn't paid";
const NOT_ADDED = "We couldn't add your CASH yet";

/** The claim's fee as the band names it ("$0.01"), when the worker has sized it. */
export function recoveryFee(record: TopUpRecord): string | undefined {
  const fee = record.recovery?.askCash;
  return fee === undefined ? undefined : `${currencyConfig.symbol}${fmtCash(BigInt(fee))}`;
}

/** The Cash the claim adds, as a decimal: what the trap holds, which a swap filled off its quote
 *  leaves apart from the quoted amount, cut to cents as a credited sum is shown; the quote until
 *  the worker found the trap. */
export function trappedCash(record: TopUpRecord): string {
  const trapped = record.recovery?.trappedAmount;
  return trapped === undefined ? record.amountHuman : fmtCashToCents(BigInt(trapped));
}

/**
 * Whether the purse can pay the fee. A read balance decides; one not yet read, or that cannot be,
 * is taken to cover it, unless the host's last word was that it did not, so a buyer whose
 * balance was topped up since is offered the purse again once the next read says so.
 */
function purseCovers(record: TopUpRecord, purse: PurseWord): boolean {
  if (purse === "none") return false;
  const { recovery } = record;
  const fee = recovery?.askCash;
  if (typeof purse === "bigint") return fee !== undefined && purse >= BigInt(fee);
  // A refusal from a round the worker moved past says nothing about the fee asked for now.
  return (
    recovery === undefined ||
    paymentOutOfRound(recovery) ||
    recovery.payment?.refusal !== "insufficient-balance"
  );
}

/** The purse was asked for the fee and has not answered yet: the host's sheet is up, or its word
 *  is still to be read back. Whatever round the worker moves to meanwhile, what the answer
 *  brings is judged once it is final, so the fee is never asked twice. The band waits on it, and
 *  the fee's confirmation says the fee is being paid; the two read this one predicate so they
 *  cannot drift apart. */
export function awaitingAnswer(recovery: TopUpRecovery | undefined): boolean {
  const payment = recovery?.payment;
  return payment?.requestedAt !== undefined && payment.status === undefined;
}

/** What the journey says and offers for a top-up in recovery; absent for any other. */
export function recoveryPrompt(
  record: TopUpRecord,
  purse: PurseWord = "unknown",
): RecoveryPrompt | undefined {
  const { status, recovery } = record;
  if (status.kind !== "recovering") return undefined;
  const cash = cashAmount(trappedCash(record));
  const paid = `The fee is paid. Your ${cash} will be in your balance in a moment.`;
  if (status.step === "claiming") {
    return { message: delay(ADDING), detail: paid, actions: [] };
  }
  const payment = recovery?.payment;
  // A deposit on the top-up's own account is being converted for the fee: found, or past its
  // first step. One the gate holds short is not; the buyer is asked on.
  const converting =
    recovery !== undefined &&
    recovery.deposit !== "await-native" &&
    (recovery.deposit !== undefined || recovery.depositFound === true);
  if (converting) {
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
  // The purse's answer is still to come, or its payment is still on its way to the burner. The
  // worker's round may move meanwhile, a deposit's claim refused or rejected: what lands is
  // judged then, against the fee asked for by then, so the fee is never asked twice.
  if (awaitingAnswer(recovery)) {
    return {
      message: delay(ALMOST_HERE),
      detail: "Waiting for the fee to be approved.",
      actions: [],
    };
  }
  // The host took the payment and is sending it: not paid yet, since the host can still fail
  // it, so the band says what is happening rather than what has not happened yet.
  if (payment?.status === "processing") {
    return {
      message: delay(ALMOST_HERE),
      detail: "Paying the fee from your balance.",
      actions: [],
    };
  }
  const asked = askFor(record, purse, fee, cash, paid);
  // What the buyer sent did not do: the worker holds a deposit short of its gate, or let one go
  // in this round. An ask says so first, so it does not read as if nothing had been sent.
  const sent = depositWord(recovery);
  if (sent === undefined || asked.actions.length === 0) return asked;
  return {
    message: asked.message.text === ALMOST_HERE ? delay(NOT_ADDED) : asked.message,
    detail: `${sent} ${asked.detail}`,
    actions: asked.actions,
  };
}

/** The band's word on a deposit that did not cover the fee, if there is one to give: one the
 *  worker holds short of its gate, which a price moving back or a little more of the token still
 *  takes up; else what became of one it let go. */
function depositWord(recovery: TopUpRecovery): string | undefined {
  if (recovery.depositFound === true && recovery.deposit === "await-native") {
    return "What you sent isn't enough yet.";
  }
  switch (recovery.depositUnused?.kind) {
    case "short":
      return "What you sent wasn't enough.";
    case "held":
      return "What you sent couldn't be converted.";
    case "trapped":
      return "What you sent didn't get through.";
    default:
      return undefined;
  }
}

/** The band's word once the purse's last answer is final: the fee paid in this round, else the
 *  ask for it, by how the purse answered and whether it covers the fee. */
function askFor(
  record: TopUpRecord,
  purse: PurseWord,
  fee: string,
  cash: string,
  paid: string,
): RecoveryPrompt {
  const recovery = record.recovery!;
  const payment = recovery.payment;
  const covers = purseCovers(record, purse);
  // The worker moved past the round the purse paid in: a claim spent the fee, or it grew.
  if (paymentOutOfRound(recovery)) {
    return {
      message: delay(NOT_ADDED),
      detail: covers
        ? `Another ${fee} network fee is needed. Pay it from your balance or from another wallet.`
        : `Another ${fee} network fee is needed.`,
      actions: covers ? [FROM_BALANCE, SEND_DEPOSIT] : [SEND_DEPOSIT],
    };
  }
  // The purse paid part of the fee: the worker asks for the rest.
  if (payment?.status === "partiallyClaimed") {
    return {
      message: delay(NOT_ADDED),
      detail: covers
        ? `Your balance covered part of the fee. Another ${fee} is needed. Pay it from your balance or from another wallet.`
        : `Your balance covered part of the fee. Another ${fee} is needed.`,
      actions: covers ? [FROM_BALANCE, SEND_DEPOSIT] : [SEND_DEPOSIT],
    };
  }
  if (payment?.status === "completed") {
    // Paid in this round: the fee is on the burner, and the claim follows.
    return { message: delay(ADDING), detail: paid, actions: [] };
  }
  if (payment?.status === "failed") {
    if (!covers) {
      return {
        message: delay(NOT_PAID),
        detail:
          payment.refusal === "insufficient-balance"
            ? "Your balance couldn't cover it."
            : `Your ${cash} is still waiting.`,
        actions: [SEND_DEPOSIT],
      };
    }
    // A balance read since may cover the fee, so the purse is offered again; a refusal for the
    // balance keeps its reason, since the host may want more than the bare fee.
    return {
      message: delay(NOT_PAID),
      detail:
        payment.refusal === "insufficient-balance"
          ? "Your balance couldn't cover it. Try again, or pay from another wallet."
          : `Your ${cash} is still waiting. Try again, or pay from another wallet.`,
      actions: [FROM_BALANCE_AGAIN, SEND_DEPOSIT],
    };
  }
  // Never asked, or asked of a host that turned out not to know the payment. A purse that cannot
  // be read is offered beside the wallet path, so a host that keeps failing never leaves the
  // purse as the only way.
  if (covers && purse === "unread") {
    return {
      message: delay(ALMOST_HERE),
      detail: `A ${fee} network fee is needed. Pay it from your balance or from another wallet.`,
      actions: [FROM_BALANCE, SEND_DEPOSIT],
    };
  }
  return covers
    ? {
        message: delay(ALMOST_HERE),
        detail: `A ${fee} network fee is needed to add it to your balance.`,
        actions: [FROM_BALANCE],
      }
    : {
        message: delay(ALMOST_HERE),
        detail: `A ${fee} network fee is needed to add it.`,
        actions: [SEND_DEPOSIT],
      };
}

/** The list row's word on a top-up in recovery: that the buyer is needed, else the band's own. */
export function recoveryHeadline(prompt: RecoveryPrompt): string {
  return prompt.actions.length > 0 ? "Needs a step from you" : prompt.message.text;
}
