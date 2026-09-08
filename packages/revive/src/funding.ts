// Funding economics: the gate math that decides when the ephemeral holds enough to spend.

import { EVM_CHAIN_DECIMAL_DIFF } from "./constants";
import type { PriceEvm } from "@getsome/core";

/** 0.3 DOT fee overhead above the price: the funding gate. */
export const DEFAULT_FEE_OVERHEAD = 3_000_000_000n;

/** 0.1 DOT: below this, a leftover balance is dust not worth a standalone sweep tx. */
export const DUST_GUARD_PLANCKS = 1_000_000_000n;

/** EVM 18-dec contract price -> chain 10-dec plancks. */
export function priceEvmToPlancks(priceEvm: PriceEvm): bigint {
  return priceEvm / 10n ** EVM_CHAIN_DECIMAL_DIFF;
}

/** Ephemeral balance the funding gate waits for: price (in plancks) + fee overhead. */
export function requiredDeposit(priceEvm: PriceEvm, feeOverhead = DEFAULT_FEE_OVERHEAD): bigint {
  return priceEvmToPlancks(priceEvm) + feeOverhead;
}

export function hasEnoughBalance(balance: bigint, required: bigint): boolean {
  return balance >= required;
}

export function shouldSweepDust(balance: bigint): boolean {
  return balance > DUST_GUARD_PLANCKS;
}
