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

/**
 * What a sale through `lane` promises its provider, from a Chainflip quote: the quoted output less
 * the delivery-fee headroom the lane keeps beyond the fee already inside it, then the lane's
 * fill-or-kill floor. Zero when the headroom takes it all.
 */
export function laneCommit(
  lane: { slippageBps: number; egressFeeHeadroom: number },
  egressAmount: bigint,
  egressFee: bigint,
): bigint {
  const headroom = egressFee * BigInt(Math.max(Math.ceil(lane.egressFeeHeadroom) - 1, 0));
  const kept = egressAmount - headroom;
  return kept <= 0n ? 0n : saleFloor(kept, lane.slippageBps);
}
