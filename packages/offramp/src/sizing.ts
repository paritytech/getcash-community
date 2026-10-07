// The sale commits to Chainflip's fill-or-kill floor: the least the swap may deliver to the
// provider. Chainflip usually delivers a little above it; the provider keeps or credits the excess.

/** The floor below the quoted output at `slippageBps`, rounded down, in the lane's base units. */
export function saleFloor(expectedOut: bigint, slippageBps: number): bigint {
  if (expectedOut <= 0n) throw new Error("saleFloor: expected output must be positive");
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
    throw new Error(`saleFloor: slippage must be an integer in [0, 10000) bps, got ${slippageBps}`);
  }
  return (expectedOut * BigInt(10_000 - slippageBps)) / 10_000n;
}
