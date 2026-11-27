// The tokens a buyer can send to a trapped top-up's own account for the claim's fee, as the
// token and deposit screens list them: in the design's order, named as the deposit screen names
// them, each with the least to send.

import { TOKENS } from "@getsome/core";
import { directAssetName, formatTwoDecimals, type RecoveryToken } from "@getsome/funding";
import type { TopUpRecovery } from "./requests/model";

export interface RecoveryChoice {
  readonly token: RecoveryToken;
  /** The token as the deposit screen names it (DOT, dotUSD, USDC, USDT). */
  readonly name: string;
  /** The least to send, as a decimal; null where the chain cannot price the token today, so the
   *  token screen lists it but does not offer it. */
  readonly amount: string | null;
}

/** The tokens in the order the screens list them. */
export const RECOVERY_TOKEN_ORDER: readonly RecoveryToken[] = ["PAS", "DOTUSD", "USDC", "USDT"];

/** The tokens the worker priced, in the design's order, one it could not price today with no
 *  amount; none until it has priced them. */
export function recoveryChoices(recovery: TopUpRecovery | undefined): RecoveryChoice[] {
  const minimums = recovery?.minimums ?? {};
  return RECOVERY_TOKEN_ORDER.flatMap((token) => {
    const figure = minimums[token];
    if (figure === undefined) return [];
    const spec = TOKENS[token];
    const amount = figure === null ? null : formatTwoDecimals(BigInt(figure), spec.decimals);
    return [{ token, name: directAssetName(spec), amount }];
  });
}
