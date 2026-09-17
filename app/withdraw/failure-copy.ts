// What the journey says about a failed withdrawal, from the failure's kind rather than the
// worker's own words.

import type { WithdrawalFailure } from "../funding/requests/model";

export function withdrawalFailureText(failure: WithdrawalFailure): string {
  switch (failure.kind) {
    case "payment-failed":
      return failure.message || "The payment from your balance did not go through.";
    case "expired":
      return "This withdrawal expired because the payment never arrived.";
    case "trapped":
      return "The transfer was held on Asset Hub. Contact support to recover it.";
    case "rejected":
      return "The network refused the conversion. You can try again.";
    case "timeout":
      return "The conversion is taking longer than expected. You can try again.";
    case "egress-failed":
      return "The transfer to your address could not be completed.";
    case "unknown":
      return failure.message || "Something went wrong with this withdrawal.";
  }
}
