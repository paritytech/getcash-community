/** `amount` less `toleranceBps` basis points of it, rounded down: the least a swap may pay for a
 *  quote of `amount`. */
export function lessTolerance(amount: bigint, toleranceBps: bigint): bigint {
  if (amount < 0n) throw new Error("the amount is negative");
  if (toleranceBps < 0n || toleranceBps > 10_000n) {
    throw new Error("the tolerance is not between 0 and 10000 basis points");
  }
  return (amount * (10_000n - toleranceBps)) / 10_000n;
}
