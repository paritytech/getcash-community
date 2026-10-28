// The tokens a buyer can send to a trapped top-up's own account for the claim's fee, as the
// token and deposit screens list them: in the design's order, named as the deposit screen names
// them, each with the least to send.

import { TOKENS } from "@getsome/core";
import { directAssetName, type RecoveryToken } from "@getsome/funding";
import type { TopUpRecovery } from "./requests/model";

export interface RecoveryChoice {
  readonly token: RecoveryToken;
  /** The token as the deposit screen names it (DOT, dotUSD, USDC, USDT). */
  readonly name: string;
  /** The least to send, as a decimal. */
  readonly amount: string;
}

const TOKEN_ORDER: readonly RecoveryToken[] = ["PAS", "DOTUSD", "USDC", "USDT"];

/** The most decimals a figure shows: a minimum rounded up reads better than ten places. */
const SHOWN_DECIMALS = 4;

/** Base units as a decimal, rounded up to SHOWN_DECIMALS, trailing zeros trimmed. Up, never
 *  down: the figure is the least to send. */
function fmtLeast(base: bigint, decimals: number): string {
  const dropped = decimals > SHOWN_DECIMALS ? decimals - SHOWN_DECIMALS : 0;
  const unit = 10n ** BigInt(dropped);
  const shown = (base + unit - 1n) / unit;
  const places = decimals - dropped;
  const s = shown.toString().padStart(places + 1, "0");
  return `${s.slice(0, -places)}.${s.slice(-places)}`.replace(/\.?0+$/, "") || "0";
}

/** The tokens the worker priced, in the design's order; none until it has. */
export function recoveryChoices(recovery: TopUpRecovery | undefined): RecoveryChoice[] {
  const minimums = recovery?.minimums ?? {};
  return TOKEN_ORDER.flatMap((token) => {
    const figure = minimums[token];
    if (typeof figure !== "string") return [];
    const spec = TOKENS[token];
    return [
      { token, name: directAssetName(spec), amount: fmtLeast(BigInt(figure), spec.decimals) },
    ];
  });
}
