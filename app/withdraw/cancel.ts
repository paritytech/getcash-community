// The withdrawal journey's one cancel affordance, and the boundary that removes it.
//
// Nothing was paid yet, and — for a Meld sale — the provider has not disclosed a deposit address.
// Past that address the seller's crypto may already be moving toward the provider and this app
// cannot see or stop an on-chain transfer, so cancelling stops being safe independently of the
// payment's own progress: `meldDepositKnown` can go true well before `paymentTaken` does, since
// the deposit address arrives from the seller finishing KYC on the provider's own page, not from
// anything the purse reports. `meldDepositKnown` is the model's own name for that boundary; this
// is the one place its two calling conditions (nothing paid, deposit not yet known) are combined,
// so every screen that offers a cancel button asks the same question the same way.

import { meldDepositKnown, paymentTaken, type WithdrawalRecord } from "../funding/requests/model";

export function withdrawalCancellable(record: WithdrawalRecord): boolean {
  if (record.status.kind !== "awaiting-payment" || paymentTaken(record)) return false;
  return record.rail.provider !== "meld" || !meldDepositKnown(record.rail);
}
