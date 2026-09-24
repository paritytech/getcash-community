// The withdrawal amount, read once: the line under it and whether Continue may open on it.
//
// The design gives the line four readings. Nothing typed yet gets the minimum as a hint; a typed
// amount that breaks a bound names the bound it broke, in the error colour; an amount that breaks
// nothing gets the standing minimum line back. The bounds are read in the order the frames pair
// them with a 226.78 purse: $3,000 is answered "Maximum $2,000 CASH" and $400 "Not enough CASH",
// so the configured maximum is reported before the purse.
//
// Openability rides the same reading, not a second pipeline: an amount opens exactly when it broke
// no bound and every bound could actually be checked — unreadable rules and an unknown purse
// (a read in flight, or a purse string the parser cannot read back) name nothing but refuse to
// open, since nothing may be withdrawn from a purse we cannot see. Only an absent purse
// (undefined: outside a host) leaves the amount capped by the configured bounds alone.
//
// The configured bounds are read through fundingAmountStatus — the same reading the shell's
// createFundingSelection takes before opening a package — so the line, the CTA and the shell can
// never drift apart on what the bounds mean. Only the purse sits on top, a withdrawal-only bound
// the shell does not know.

import { cashAmount, groupAmountDigits } from "../utils/cash";
import { fundingAmountStatus, parseFundingAmount } from "../funding/selection";
import { currencyConfig, type FundingSelectorConfig } from "../funding/config";

export interface WithdrawalAmountAssessment {
  text: string;
  /** A bound the amount broke. The design writes these in the error colour; the hint that stands
   *  in for them before anything is typed stays secondary. */
  breach: boolean;
  /** Whether the withdrawal can be opened on this amount. */
  withdrawable: boolean;
}

export function assessWithdrawalAmount(
  amount: string,
  /** The bounds, read from the config so the line and the shell can never drift on them. */
  config: Pick<FundingSelectorConfig, "amount">,
  /** The purse the amount is drawn from, as an amount string. Null while the purse is still being
   *  read, undefined where there is no purse at all. */
  available: string | null | undefined,
): WithdrawalAmountAssessment {
  const rules = config.amount;
  const money = (value: string): string => cashAmount(groupAmountDigits(value));
  const hint = { text: `Minimum ${money(rules.minimum)}`, breach: false, withdrawable: false };
  // Nothing entered yet: the screen reads "$0", which the design answers with the hint. The one
  // reading fundingAmountStatus cannot give — it files zero under below-minimum, a breach.
  const entered = parseFundingAmount(amount, rules.decimals);
  if (entered === null || entered === 0n) return hint;

  const status = fundingAmountStatus(amount, rules);
  // Rules the parser cannot read back are a misconfiguration: the hint stands and nothing opens,
  // as the top-up screen's CTA disables in the same state.
  if (status.kind === "invalid") return hint;
  if (status.kind === "below-minimum") return { ...hint, breach: true };
  if (status.kind === "above-maximum")
    return { text: `Maximum ${money(rules.maximum)}`, breach: true, withdrawable: false };

  const standing = {
    text: `Withdrawal minimum ${money(rules.minimum)}`,
    breach: false,
    withdrawable: true,
  };
  // Provably no purse: only the configured bounds apply.
  if (available === undefined) return standing;
  const purse = available === null ? null : parseFundingAmount(available, rules.decimals);
  // Unknown purse: no bound to name yet, but the gate stays closed until it can be seen.
  if (purse === null) return { ...standing, withdrawable: false };
  if (status.baseUnits > purse)
    return { text: `Not enough ${currencyConfig.ticker}`, breach: true, withdrawable: false };
  return standing;
}
