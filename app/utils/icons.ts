// The icon set in public/icons. A network's icon doubles as its native token's.

const NETWORK_ICONS: Record<string, string> = {
  Bitcoin: "/icons/bitcoin.svg",
  Ethereum: "/icons/ethereum.svg",
  Solana: "/icons/solana.svg",
  Tron: "/icons/tron.svg",
  Polkadot: "/icons/polkadot.svg",
};

const TOKEN_ICONS: Record<string, string> = {
  BTC: NETWORK_ICONS.Bitcoin!,
  ETH: NETWORK_ICONS.Ethereum!,
  SOL: NETWORK_ICONS.Solana!,
  TRX: NETWORK_ICONS.Tron!,
  DOT: NETWORK_ICONS.Polkadot!,
  USDC: "/icons/usdc.svg",
  USDT: "/icons/usdt.svg",
};

/** A network's icon, or the generic add-money icon for an unknown network. */
export function networkIcon(chain: string): string {
  return NETWORK_ICONS[chain] ?? "/icons/add-money.svg";
}

export function tokenIcon(asset: string): string {
  return TOKEN_ICONS[asset] ?? "/icons/add-money.svg";
}
