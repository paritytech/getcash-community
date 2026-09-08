// Indicative USD reference rates for the demo CASH quote display, rendered with a leading ≈.
const USD_RATES: Record<string, number> = {
  BTC: 110_000,
  ETH: 3_500,
  SOL: 150,
  TRX: 0.28,
  USDC: 1,
  USDT: 1,
  DOT: 4,
};

function fmtAmount(amount: number): string | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const digits = amount >= 1 ? 4 : 8;
  return amount
    .toFixed(digits)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}

/** Estimated source-asset amount equivalent to `nativeBase` (10-dec DOT base units).
 *  Null when the asset has no reference rate. */
export function estimateSourceAmount(nativeBase: bigint, sourceSymbol: string): string | null {
  const src = USD_RATES[sourceSymbol];
  const dot = USD_RATES.DOT;
  if (!src) return null;
  return fmtAmount(((Number(nativeBase) / 1e10) * dot) / src);
}

/** Estimated source-asset amount for `cashBase` (6-dec CASH, pegged ~1 USD). */
export function estimateSourceFromCash(cashBase: bigint, sourceSymbol: string): string | null {
  const src = USD_RATES[sourceSymbol];
  if (!src) return null;
  return fmtAmount(Number(cashBase) / 1e6 / src);
}

// Demo deposit addresses per source chain, in each chain's real format.
const DEMO_DEPOSIT_ADDRESSES: Record<string, string> = {
  Bitcoin: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
  Ethereum: "0x52908400098527886E0F7030069857D2E4169EE7",
  Solana: "4Nd1mYQx3sABznWXpq2mV3G7iC6nnZq6dvGnHLm2rrDF",
  Tron: "TQWB8P4RTpRjtjFCRMsd9qzMGdbs4epKaP",
};

/** The demo deposit address to display for a source chain; null shows the real one. */
export function demoDepositAddress(chain: string | null): string | null {
  return chain ? (DEMO_DEPOSIT_ADDRESSES[chain] ?? null) : null;
}
