// Block-explorer links for the chains a refund can land on.
//
// The Polkadot side runs on Paseo, but the source chains a deposit arrives from are mainnet
// (`NETWORK` in `lib/chainflip-backend` is "mainnet"), so these are the live explorers and a
// refund transaction resolves on them.

import type { RefundChain } from "@getsome/ephemeral";

/** Transaction URL per chain, `{tx}` standing in for the reference. */
const TX_URL: Record<RefundChain, string> = {
  Bitcoin: "https://mempool.space/tx/{tx}",
  Ethereum: "https://etherscan.io/tx/{tx}",
  Arbitrum: "https://arbiscan.io/tx/{tx}",
  Tron: "https://tronscan.org/#/transaction/{tx}",
  Solana: "https://solscan.io/tx/{tx}",
};

/**
 * Where to watch a refund transaction, or null for a chain with no explorer mapped.
 *
 * Null rather than a guessed URL: sending a buyer chasing their money to a page that does not
 * resolve is worse than leaving them with the reference to search themselves, which they still
 * have because it is shown and copyable either way.
 */
export function refundTxUrl(chain: RefundChain | null, txRef: string | undefined): string | null {
  if (chain === null || !txRef) return null;
  const template = TX_URL[chain];
  return template ? template.replace("{tx}", encodeURIComponent(txRef)) : null;
}
