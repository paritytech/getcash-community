// Maps the adapter's funding lifecycle onto core's SwapProgress vocabulary. This reports the fiat
// payment's progress; the funding pipeline confirms the native-token arrival on the burner.

import type { FailureKind, SwapStatusResult } from "@getsome/core";
import type { MeldClientLike } from "./client";

/** Delivered. The adapter saw a settled transaction filed under this request. */
const SETTLED = "settled";

/** Underway: a transaction exists against this request but has not concluded. */
const RECEIVING = "transaction_seen";

/**
 * Temporarily stuck, NOT terminal: the provider's crypto delivery failed and is being retried on
 * their side (Meld's TRANSACTION_CRYPTO_FAILED webhook). The poll keeps going and the journey
 * shows a delay notice; a payment that stays stuck concludes through one of the terminal states.
 */
const DELAYED = new Set(["crypto_failed", "transaction_crypto_failed"]);

/** A Meld status view: core's normalized status plus the transient delay marker. */
export type MeldStatusView = SwapStatusResult & { delayed?: boolean };

/**
 * Terminal with the money returned (Meld's REFUNDED: the charge was captured, then sent back to
 * the card). Unlike `failed`, money moved, so the message says so — with the charged amount when
 * the adapter reports the request's terms.
 */
const REFUNDED = "refunded";

function refundedMessage(sourceAmount?: string, fiat?: string): string {
  const returned = sourceAmount && fiat ? `Your ${sourceAmount} ${fiat}` : "Your money";
  return `Your top-up didn't go through. ${returned} has been returned to your card.`;
}

/**
 * Terminal failures, each with its own message.
 *
 * - `failed`: the payment failed.
 * - `expired`: nobody paid inside the window.
 * - `refused`: declined before any payment was possible.
 * - `unobserved`: the adapter could not tell whether a payment happened.
 */
const FAILURES: Readonly<Record<string, { message: string; kind: FailureKind }>> = Object.freeze({
  failed: {
    message: "Top-up didn't go through. No money was taken.",
    kind: "deposit-rejected",
  },
  expired: {
    message: "The payment window closed before the payment arrived.",
    kind: "expired",
  },
  refused: { message: "The payment was declined before it started.", kind: "deposit-rejected" },
  unobserved: {
    message: "We could not confirm this payment. Contact support before trying again.",
    kind: "unknown",
  },
});

/** Fetch and normalize a funding request's status. Early states stay 'waiting'. */
export async function getMeldStatus(
  client: MeldClientLike,
  fundingRequestId: string,
): Promise<MeldStatusView> {
  const { status, sourceAmount, fiat } = await client.getStatus(fundingRequestId);
  if (status === SETTLED) return { status: "complete", raw: status };
  if (status === RECEIVING) return { status: "receiving", raw: status };
  // The payment went through; only the crypto delivery is stuck and retrying.
  if (DELAYED.has(status)) return { status: "receiving", delayed: true, raw: status };
  if (status === REFUNDED) {
    return {
      status: "failed",
      depositFailure: {
        reason: { code: status, message: refundedMessage(sourceAmount, fiat) },
        kind: "deposit-rejected",
      },
      raw: status,
    };
  }
  const failure = FAILURES[status];
  if (failure !== undefined) {
    // The kind travels with the message; core's default kind is `deposit-rejected`.
    return {
      status: "failed",
      depositFailure: { reason: { code: status, message: failure.message }, kind: failure.kind },
      raw: status,
    };
  }
  // `created`, `session_opened`, and any state added later.
  return { status: "waiting", raw: status };
}
