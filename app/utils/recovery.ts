// Copy for the recovery panel: the secret's label and the gas note for a token refund.

import type { RefundChain, RefundKey } from "@getsome/ephemeral";

const NATIVE_COIN: Record<RefundChain, string> = {
  Bitcoin: "BTC",
  Ethereum: "ETH",
  Arbitrum: "ETH",
  Tron: "TRX",
  Solana: "SOL",
};

/** A failure whose funds come back to the request's own refund key. */
export function refundedFailure(kind: string): boolean {
  return kind === "refunded" || kind === "refund-failed";
}

export interface RecoveryNotes {
  secretLabel: string;
  /** Gas note for a refunded token; null when the refund is the chain's own coin. */
  gasNote: string | null;
}

export function recoveryNotes(key: RefundKey, asset: string): RecoveryNotes {
  const native = NATIVE_COIN[key.chain];
  return {
    secretLabel:
      key.format === "wif"
        ? "Private key (WIF)"
        : key.format === "base58"
          ? "Secret key"
          : "Private key",
    gasNote:
      native === asset
        ? null
        : `${asset} on ${key.chain} needs ${native} in this address to move. Send a little ${native} there first.`,
  };
}
