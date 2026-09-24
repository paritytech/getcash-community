// Where a withdrawal can go: the networks the picker lists, the tokens on each, and for each
// destination how an address is checked and where the PAS lands on Asset Hub. Asset Hub itself is
// the direct destination, reached by the XCM alone. The Chainflip networks are listed as the
// design shows them; whether a row can be picked for an amount is the floor store's call.

import { AccountId } from "polkadot-api";
import { SOURCE_CONFIG_BY_ID } from "@getsome/chainflip";
import type { WithdrawalRailState } from "../funding/requests/model";
import { networkIcon, tokenIcon } from "../utils/icons";
import { SOURCE_CHAINS, sourceIdFor } from "~~/lib/config";

export interface WithdrawDestination {
  /** The destination's id, the tail of the withdrawal's source id: `dot-assethub`, `btc`. */
  id: string;
  /** The network as Chainflip and the icon set name it. */
  chain: string;
  chainLabel: string;
  asset: string;
  rail: WithdrawalRailState["provider"];
  validateAddress(address: string): boolean;
}

export interface WithdrawNetwork {
  chain: string;
  label: string;
  icon: string;
  destinations: readonly WithdrawDestination[];
}

const ASSET_HUB_CHAIN = "AssetHub";

const accountId = AccountId();

/** A 32-byte account in any SS58 prefix. */
export function isAssetHubAddress(address: string): boolean {
  try {
    return accountId.enc(address.trim()).length === 32;
  } catch {
    return false;
  }
}

/** The account's public key, hex, for the XCM's landing account. */
export function assetHubAccountHex(address: string): `0x${string}` {
  const bytes = accountId.enc(address.trim());
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const assetHub: WithdrawDestination = Object.freeze({
  id: "dot-assethub",
  chain: ASSET_HUB_CHAIN,
  chainLabel: "Asset Hub",
  asset: "DOT",
  rail: "direct",
  validateAddress: isAssetHubAddress,
});

/** The Chainflip destinations, one per source the on-ramp knows, each checked with the same
 *  validator the on-ramp applies to a refund address on that chain. */
function chainflipDestinations(chain: string, assets: readonly string[]): WithdrawDestination[] {
  return assets.flatMap((asset) => {
    const sourceId = sourceIdFor(chain, asset);
    const config = sourceId === undefined ? undefined : SOURCE_CONFIG_BY_ID.get(sourceId);
    if (config === undefined) return [];
    return [
      Object.freeze({
        id: config.sourceId,
        chain,
        chainLabel: chain,
        asset,
        rail: "chainflip" as const,
        validateAddress: (address: string) => config.validateRefundAddress(address.trim()),
      }),
    ];
  });
}

/** The networks in picker order: Asset Hub first, then the Chainflip networks. */
export const WITHDRAW_NETWORKS: readonly WithdrawNetwork[] = Object.freeze([
  Object.freeze({
    chain: ASSET_HUB_CHAIN,
    // The design names the row by the relay; the destination itself stays Asset Hub.
    label: "Polkadot",
    icon: networkIcon("Polkadot"),
    destinations: Object.freeze([assetHub]),
  }),
  ...SOURCE_CHAINS.map(({ chain, label, assets }) =>
    Object.freeze({
      chain,
      label,
      icon: networkIcon(chain),
      destinations: Object.freeze(chainflipDestinations(chain, assets)),
    }),
  ),
]);

export const withdrawNetwork = (chain: string): WithdrawNetwork | undefined =>
  WITHDRAW_NETWORKS.find((network) => network.chain === chain);

export const withdrawDestination = (id: string): WithdrawDestination | undefined =>
  WITHDRAW_NETWORKS.flatMap((network) => network.destinations).find(
    (destination) => destination.id === id,
  );

export const destinationTokenIcon = (destination: WithdrawDestination): string =>
  tokenIcon(destination.asset);

/** The Asset Hub account the PAS lands on for a destination: the address itself for Asset Hub.
 *  Null for a provider destination: the PAS lands on the withdrawal's own key, which then pays
 *  the provider and is where a refund comes back to. */
export function landingAccountHex(
  destination: WithdrawDestination,
  address: string,
): `0x${string}` | null {
  return destination.rail === "direct" ? assetHubAccountHex(address) : null;
}

/** The address as the summary shows it: the first and last characters around an ellipsis. */
export function shortAddress(address: string): string {
  const trimmed = address.trim();
  return trimmed.length <= 13 ? trimmed : `${trimmed.slice(0, 5)}…${trimmed.slice(-5)}`;
}
