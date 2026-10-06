// What the journey says about a failed withdrawal, from the failure's kind rather than the
// worker's own words.

import type { WithdrawalFailure } from "../funding/requests/model";

export function withdrawalFailureText(failure: WithdrawalFailure): string {
  switch (failure.kind) {
    case "payment-failed":
      return failure.message || "The payment from your balance did not go through.";
    case "expired":
      return "This withdrawal expired because the payment never arrived.";
    case "rejected":
      return "The network refused the transaction. You can try again.";
    case "timeout":
      return "The conversion is taking longer than expected. You can try again.";
    case "egress-failed":
      return "The transfer to your address could not be completed.";
    case "deposit-rejected":
      return "The provider did not accept the funds.";
    case "fallback-egress":
      return "The provider sent the funds somewhere else. Contact support.";
    case "refunded":
      return "The swap did not go through and the funds came back. You can try again.";
    case "channel-expired":
      return "This withdrawal took too long to pay for. Nothing was sent, so you can try again.";
    case "channel-mismatch":
      return "We could not confirm this withdrawal with the provider. Nothing was sent, so you can try again.";
    case "unfundable":
      // Before the purse was asked, nothing left the balance; after, the key's funds go home.
      return failure.step === "payment"
        ? "The price moved too far while you verified. Nothing was taken from your balance."
        : "The price moved too far after your payment, so nothing was sent to the provider. Your funds are coming back to your balance.";
    case "unresolved":
      return "We could not confirm the payment to the provider. Contact support with your reference.";
    case "sale-ended":
      return `${failure.message || "The provider ended the sale."} Nothing was taken from your balance.`;
    case "sale-expired":
      return "This sale expired before it was completed. Nothing was taken from your balance.";
    case "sale-mismatch":
      return "The provider changed the terms of the sale, so nothing was sent.";
    case "sale-closed":
      return "The sale could not be completed, so nothing was sent to the provider. Your funds are coming back to your balance.";
    case "unknown":
      return failure.message || "Something went wrong with this withdrawal.";
  }
}
