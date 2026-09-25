// Indicative USD reference rates for the demo CASH quote display, rendered with a leading ≈.
const USD_RATES: Record<string, number> = {
  BTC: 84_500,
  ETH: 2_670,
  SOL: 114,
  TRX: 0.34,
  USDC: 1,
  USDT: 1,
  DOT: 1.1,
};

function fmtAmount(amount: number): string | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const digits = amount >= 1 ? 4 : 8;
  return amount
    .toFixed(digits)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}

/** Estimated source-asset amount equivalent to `depositBase`, the deposit in `depositToken`'s own
 *  base units. The deposit asset follows the conversion route, the native on the pool tier and a
 *  stable on the stable tiers, so its decimals and its reference rate both come from the token
 *  rather than being assumed to be DOT's. Null when either asset has no reference rate. */
export function estimateSourceAmount(
  depositBase: bigint,
  depositToken: { symbol: string; chainflipAsset?: string; decimals: number },
  sourceSymbol: string,
): string | null {
  const src = USD_RATES[sourceSymbol];
  const deposit = USD_RATES[depositToken.chainflipAsset ?? depositToken.symbol];
  if (!src || !deposit) return null;
  return fmtAmount(((Number(depositBase) / 10 ** depositToken.decimals) * deposit) / src);
}

/** Estimated source-asset amount for `cashBase` (6-dec CASH, pegged ~1 USD). */
export function estimateSourceFromCash(cashBase: bigint, sourceSymbol: string): string | null {
  const src = USD_RATES[sourceSymbol];
  if (!src) return null;
  return fmtAmount(Number(cashBase) / 1e6 / src);
}
