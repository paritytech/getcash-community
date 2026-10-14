// The withdrawal amount, read once: the line under it and whether Continue may open on it.
//
// The configured bounds come through fundingAmountStatus — the same reading the shell takes — so
// the line, the CTA and the shell can never drift. The bounds report in the frames' order (the
// configured maximum before the purse), and the gate fails closed while the purse is unknown,
// open only where there is provably none (undefined: outside a host).

import { cashToRuleUnits, groupAmountDigits } from "../utils/cash";
import { fundingAmountStatus, parseFundingAmount } from "../funding/selection";
import { currencyConfig, type FundingSelectorConfig } from "../funding/config";

export interface WithdrawalAmountAssessment {
  /** The words before the figure; the whole line where there is no figure to write. */
  lead: string;
  /** The bound as a grouped amount string; null where the line carries no figure. */
  amount: string | null;
  /** A bound the amount broke; drawn in the error colour. */
  breach: boolean;
  withdrawable: boolean;
}

export function assessWithdrawalAmount(
  amount: string,
  /** The bounds, read from the config so the line and the shell can never drift on them. */
  config: Pick<FundingSelectorConfig, "amount">,
  /** The purse the amount is drawn from, in base units of CASH. Null while the purse is still
   *  being read, undefined where there is no purse at all. */
  available: bigint | null | undefined,
): WithdrawalAmountAssessment {
  const rules = config.amount;
  const hint = {
    lead: "Minimum ",
    amount: groupAmountDigits(rules.minimum),
    breach: false,
    withdrawable: false,
  };
  // Nothing entered yet gets the hint — fundingAmountStatus would file zero as a breach.
  const entered = parseFundingAmount(amount, rules.decimals);
  if (entered === null || entered === 0n) return hint;

  const status = fundingAmountStatus(amount, rules);
  // Unreadable rules are a misconfiguration: the hint stands and nothing opens.
  if (status.kind === "invalid") return hint;
  if (status.kind === "below-minimum") return { ...hint, breach: true };
  if (status.kind === "above-maximum")
    return {
      lead: "Maximum ",
      amount: groupAmountDigits(rules.maximum),
      breach: true,
      withdrawable: false,
    };

  // An amount that breaks nothing needs no line: the design's Entered frame carries none.
  const standing = { lead: "", amount: null, breach: false, withdrawable: true };
  // Provably no purse: only the configured bounds apply.
  if (available === undefined) return standing;
  // Unknown purse: no bound to name yet, but the gate stays closed until it can be seen.
  if (available === null) return { ...standing, withdrawable: false };
  // Truncated to the keypad's scale — sub-cent dust never lends the gate more than the pill offers.
  const purse = cashToRuleUnits(available, rules.decimals);
  if (status.baseUnits > purse)
    return {
      lead: `Not enough ${currencyConfig.ticker}`,
      amount: null,
      breach: true,
      withdrawable: false,
    };
  return standing;
}
