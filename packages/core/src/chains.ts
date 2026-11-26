/** The EVM chains, as Chainflip names them. */
const EVM_CHAIN_NAMES = ["Ethereum", "Arbitrum", "Bsc"] as const;

export type EvmChain = (typeof EVM_CHAIN_NAMES)[number];

export const isEvmChain = (chain: string): chain is EvmChain =>
  (EVM_CHAIN_NAMES as readonly string[]).includes(chain);
