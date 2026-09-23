// Pure helpers the Meld sell surface shares between the pre-confirm quote and the post-confirm
// journey: what a Meld withdrawal's `destination` carries in place of a crypto address, and the
// one place the exact-crypto/estimated-fiat distinction is rendered, so no screen can forget to
// mark the estimate as one.
//
// THE DISTINCTION THIS FILE EXISTS TO ENFORCE: the committed crypto is exact — it is what actually
// leaves the seller's purse, sized ahead of time by `sizeCommitment` — and the fiat payout is a
// number the provider has not locked and only prices for real when it converts. A screen that
// formats either figure by hand can drop the "≈" on the one that needs it; a screen that calls
// through here cannot.

import { formatNative } from "@getsome/meld";
import { fmtFiat } from "../utils/money";
import type { Observation, WithdrawalRecord } from "../funding/requests/model";

/** The Meld payout methods a withdrawal can route through. */
export type MeldWithdrawMethod = "card" | "bank";

/** `WithdrawalStart.destinationId` for a Meld sale, mirroring the top-up side's own source ids
 *  (`meld-card`, `meld-bank`) — see `meldMethodFor` in `../funding/source-ids`, which reads this
 *  same string back into a method. */
export const meldWithdrawDestinationId = (method: MeldWithdrawMethod): string => `meld-${method}`;

/** A Meld withdrawal has no crypto address of its own to land on; this is what `destination`
 *  carries in its place, for the rows and the journey to show. */
export function meldSellDestination(method: MeldWithdrawMethod): WithdrawalRecord["destination"] {
  return {
    chain: "Meld",
    asset: method === "bank" ? "Bank" : "Card",
    address: method === "bank" ? "Your bank account" : "Your card",
  };
}

/** The crypto this withdrawal commits to the sale, exact — never marked as an estimate, because
 *  it is not one. */
export function formatCommittedCrypto(committedAmountPlanck: string): string {
  return `${formatNative(BigInt(committedAmountPlanck))} DOT`;
}

/** The fiat the sale is quoted at, always marked as an estimate: the provider has not locked it in.
 *  Every caller that shows this figure goes through here, so the "≈" is never a choice a screen
 *  can forget to make. */
export function formatEstimatedPayout(
  quotedFiatAmount: string,
  quotedFiatCurrency: string,
): string {
  return `≈ ${fmtFiat(quotedFiatAmount, quotedFiatCurrency)}`;
}

/** The journey's one-line status once a Meld sale has paid out, in place of the crypto rails'
 *  "Sent to <address>": there is no address to shorten, only the payout method. */
export function meldSentMessage(method: MeldWithdrawMethod): string {
  return method === "bank" ? "Paid to your bank account" : "Paid to your card";
}

// Browser demo only: the worker legs the host would run (funds seen, then done), so a disclosed sale reaches "sent".
export function browserSettlementObservations(
  seenAt: number,
  doneAt: number,
): [Observation, Observation] {
  return [
    {
      source: "worker",
      at: seenAt,
      withdrawJob: { phase: "swap", done: false, fundsSeenAt: seenAt, lastTickAt: seenAt },
    },
    {
      source: "worker",
      at: doneAt,
      withdrawJob: { phase: "pay-provider", done: true, fundsSeenAt: seenAt, lastTickAt: doneAt },
    },
  ];
}
