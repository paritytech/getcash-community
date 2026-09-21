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
    case "deposit-rejected":
      return "The provider did not accept the funds.";
    case "fallback-egress":
      return "The provider sent the funds somewhere else. Contact support.";
    case "refunded":
      return "The swap did not go through and the funds came back. You can try again.";
    case "unknown":
      return failure.message || "Something went wrong with this withdrawal.";
  }
}
