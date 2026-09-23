// Maps the adapter's funding lifecycle onto core's SwapProgress vocabulary. This reports the fiat
// payment's progress; the funding pipeline confirms the native-token arrival on the burner.

import type { FailureKind, SwapStatusResult } from "@getsome/core";
import type { MeldClientLike, MeldDepositDisclosure } from "./client";

/** Delivered. The adapter saw a settled transaction filed under this request. */
const SETTLED = "settled";

/** Underway: a transaction exists against this request but has not concluded. */
const RECEIVING = "transaction_seen";

/**
 * Temporarily stuck, NOT terminal: the provider's crypto delivery failed and is being retried on
 * their side (Meld's TRANSACTION_CRYPTO_FAILED event, which the adapter learns by polling Meld —
 * nothing is pushed to us at any hop). The poll keeps going and the journey
 * shows a delay notice; a payment that stays stuck concludes through one of the terminal states.
 */
const DELAYED = new Set(["crypto_failed", "transaction_crypto_failed"]);

/**
 * A Meld status view: core's normalized status, the transient delay marker, and a sell's deposit
 * terms when this poll disclosed them.
 *
 * `deposit` rides along rather than being folded into the normalized status because it is not a
 * status at all — it is the instruction the seller has to act on, and the coarse states cannot
 * carry it. It is present only on the polls the adapter discloses it on, so a caller reads it
 * from the poll it came with and never from a remembered copy: the terms can be withdrawn, and
 * an address kept after that is an address nobody is standing behind.
 */
export type MeldStatusView = SwapStatusResult & {
  delayed?: boolean;
  deposit?: MeldDepositDisclosure;
};

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
 * - `declined`: the bank refused the card during payment.
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
  // The bank refused the card mid-payment (Meld's DECLINED) — distinct from `refused`, which is
  // the adapter turning the request away before any payment was possible.
  declined: {
    message: "Your bank declined the payment. Check your card details or try another card.",
    kind: "deposit-rejected",
  },
  unobserved: {
    message: "We could not confirm this payment. Contact support before trying again.",
    kind: "unknown",
  },
});

/**
 * The provider endings the buyer must be told apart, keyed on the provider's own status.
 *
 * The adapter's lifecycle has no `refunded` and no `declined`: its rail maps
 * FAILED / DECLINED / CANCELLED / REFUNDED all onto `failed` and lets the provider's own string
 * ride along in `providerStatus` (see the adapter's `meld/rail.ts`). So the coarse status says
 * only that the payment ended, and this says how — which is the difference between "your money
 * came back", "your bank said no", and "nothing was taken".
 *
 * An ending not listed here keeps the coarse status's own wording, so a provider string we have
 * never seen is never guessed at.
 */
function providerEnding(
  providerStatus: string | undefined,
  sourceAmount?: string,
  fiat?: string,
): { code: string; message: string } | null {
  switch (providerStatus?.trim().toUpperCase()) {
    case "REFUNDED":
      return { code: REFUNDED, message: refundedMessage(sourceAmount, fiat) };
    case "DECLINED":
      return { code: "declined", message: FAILURES.declined!.message };
    // The buyer's own doing, or the provider's window closing on them. No money moved, so it reads
    // as the plain failure does rather than inventing a sentence for it.
    case "CANCELLED":
    case "CANCELED":
      return { code: "cancelled", message: FAILURES.failed!.message };
    default:
      return null;
  }
}

/** Fetch and normalize a funding request's status. Early states stay 'waiting'. */
export async function getMeldStatus(
  client: MeldClientLike,
  fundingRequestId: string,
): Promise<MeldStatusView> {
  const { status, providerStatus, sourceAmount, fiat, deposit } =
    await client.getStatus(fundingRequestId);
  // A sell's deposit terms, on the polls that disclosed them. Carried onto the live views only:
  // the adapter withholds them once a request concludes, so a terminal view that somehow had
  // them would be showing a seller an address nobody is standing behind any more.
  const disclosed = deposit !== undefined ? { deposit } : {};
  if (status === SETTLED) return { status: "complete", raw: status };
  if (status === RECEIVING) return { status: "receiving", raw: status, ...disclosed };
  // The payment went through; only the crypto delivery is stuck and retrying.
  if (DELAYED.has(status)) return { status: "receiving", delayed: true, raw: status, ...disclosed };
  // Kept for an adapter whose lifecycle grows the state itself; today the refund arrives as
  // `failed` with a REFUNDED provider status, handled below.
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
    // Only `failed` collapses a provider ending; the adapter's own endings keep their wording.
    const ending = status === "failed" ? providerEnding(providerStatus, sourceAmount, fiat) : null;
    const reason = ending ?? { code: status, message: failure.message };
    // The kind travels with the message; core's default kind is `deposit-rejected`.
    return {
      status: "failed",
      depositFailure: { reason, kind: failure.kind },
      // The provider's string is the more specific of the two, and the store reads `raw` to tell
      // one ending from another.
      raw: providerStatus ?? status,
    };
  }
  // `created`, `session_opened`, and any state added later. This is where a sell spends most of
  // its life, and where its deposit terms are read from.
  return { status: "waiting", raw: status, ...disclosed };
}
