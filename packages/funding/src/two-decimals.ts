// The figures a buyer is asked to send, in two decimals of the token: rounded up, so what is
// asked never falls short of what is needed, and printed with both decimals.

const SHOWN_DECIMALS = 2;

/** One step of the token's second decimal, in its base units. */
const stepOf = (decimals: number): bigint => 10n ** BigInt(Math.max(decimals - SHOWN_DECIMALS, 0));

/** Base units rounded up to the token's second decimal; a figure already on it is unchanged. */
export function ceilToTwoDecimals(base: bigint, decimals: number): bigint {
  const step = stepOf(decimals);
  return ((base + step - 1n) / step) * step;
}

/** Base units as a decimal with exactly two places (`10.10`, `5.00`), rounded up to them. */
export function formatTwoDecimals(base: bigint, decimals: number): string {
  const digits = ceilToTwoDecimals(base, decimals)
    .toString()
    .padStart(decimals + 1, "0");
  const point = digits.length - decimals;
  const fraction = digits.slice(point, point + SHOWN_DECIMALS).padEnd(SHOWN_DECIMALS, "0");
  return `${digits.slice(0, point)}.${fraction}`;
}
