const BPS = 10_000n;

export type FeeParams = {
  bridgeFee: bigint;
  frontFeeBps: number;
  capBps: number;
};

// Mirrors Pool.front: fee >= bridgeFee, fee < amount, and fee - bridgeFee <= amount * capBps / 10_000.
// Returns undefined when the deposit cannot carry the fee.
export function computeFee(amount: bigint, { bridgeFee, frontFeeBps, capBps }: FeeParams): bigint | undefined {
  const bps = BigInt(Math.min(frontFeeBps, capBps));
  const fee = bridgeFee + (amount * bps) / BPS;
  return fee < amount ? fee : undefined;
}
