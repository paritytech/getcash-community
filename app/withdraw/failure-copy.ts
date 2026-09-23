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
      return "The network refused the conversion. You can try again.";
    case "timeout":
      return "The conversion is taking longer than expected. You can try again.";
    case "egress-failed":
      return "The transfer to your address could not be completed.";
    case "unresolved":
      // Not "try again": whether the payout went out is exactly what nobody knows yet, and a
      // second attempt is the one thing that must not happen on its own.
      return "We could not confirm the payout. Please contact support before trying again.";
    case "unknown":
      return failure.message || "Something went wrong with this withdrawal.";
  }
}
