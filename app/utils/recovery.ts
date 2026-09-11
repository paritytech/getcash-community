// Copy for the return-funds screen: the secret's label, the status line's tail, and the numbered
// steps that walk a refund into a wallet.

import type { RefundProgress } from "@getsome/core";
import type { RefundChain, RefundKey } from "@getsome/ephemeral";
import { shortAddress } from "./address";

const NATIVE_COIN: Record<RefundChain, string> = {
  Bitcoin: "BTC",
  Ethereum: "ETH",
  Arbitrum: "ETH",
  Tron: "TRX",
  Solana: "SOL",
};

/** Gas amounts the design spells out; chains without one keep the generic sentence. */
const SUGGESTED_GAS: Partial<Record<RefundChain, string>> = {
  Tron: "15 TRX",
};

/** A failure whose funds come back to the request's own refund key. */
export function refundedFailure(kind: string): boolean {
  return kind === "refunded" || kind === "refund-failed";
}

export interface RecoveryNotes {
  secretLabel: string;
  /** Step-one gas note for a refunded token; null when the refund is the chain's own coin. */
  gasNote: string | null;
  importNote: string;
  transferNote: string;
}

/** The key's format refines the label once revealed; the default fits every chain before that. */
export function recoveryNotes(
  chain: RefundChain,
  asset: string,
  format?: RefundKey["format"],
): RecoveryNotes {
  const native = NATIVE_COIN[chain];
  const gas = SUGGESTED_GAS[chain];
  return {
    secretLabel:
      format === "wif" ? "Private key (WIF)" : format === "base58" ? "Secret key" : "Private key",
    gasNote:
      native === asset
        ? null
        : `${asset} on ${chain} can't move without ${native}. Send a small amount to this ` +
          `address first${gas ? `, around ${gas} is enough` : ""}. If you don't have ${native}, ` +
          `you can buy it on any exchange.`,
    importNote: `Import this key into any wallet that supports ${chain}.`,
    transferNote: `Transfer your ${asset} to any ${chain} address you control`,
  };
}

/** The status line's tail after "Your 50 USDT": how far the refund has come. */
export function refundStatusTail(refund?: RefundProgress): string {
  if (refund?.witnessedAt) return "is back at your recovery address.";
  if (refund?.txRef) return `is on its way back, transaction ${shortAddress(refund.txRef)}.`;
  return "is being returned to your recovery address.";
}
