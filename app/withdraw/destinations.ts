// Where a withdrawal can go: the networks the picker lists, the tokens on each, and for each
// destination how an address is checked, what the CASH lands as on Asset Hub, and where. Asset
// Hub itself is the direct destination, reached by the XCM alone, in any of the tokens the
// on-ramp takes from Polkadot. The Chainflip networks are listed as the design shows them;
// whether a row can be picked for an amount is the floor store's call.

import { AccountId } from "polkadot-api";
import { SOURCE_CONFIG_BY_ID } from "@getsome/chainflip";
import type { DepositAsset } from "@getsome/funding";
import type { WithdrawalRailState } from "../funding/requests/model";
import { elideMiddle } from "../utils/address";
import { networkIcon, tokenIcon } from "../utils/icons";
import { SOURCE_CHAINS, sourceIdFor } from "~~/lib/config";

export interface WithdrawDestination {
  /** The destination's id, the tail of the withdrawal's source id: `usdc-assethub`, `btc`. */
  id: string;
  /** The network as Chainflip and the icon set name it. */
  chain: string;
  chainLabel: string;
  asset: string;
  rail: WithdrawalRailState["provider"];
  /** What the CASH lands as on Asset Hub, named as the on-ramp names a deposit: the token picked
   *  for Asset Hub itself, the native for a provider, which takes PAS from the key. The sale that
   *  gets there is decided at quote time from it. */
  landing: DepositAsset;
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

const assetHubDestination = (
  id: string,
  asset: string,
  landing: DepositAsset,
): WithdrawDestination =>
  Object.freeze({
    id,
    chain: ASSET_HUB_CHAIN,
    chainLabel: "Asset Hub",
    asset,
    rail: "direct",
    landing,
    validateAddress: isAssetHubAddress,
  });

/** Asset Hub's own destinations, the tokens the on-ramp takes from Polkadot in its order, each
 *  under the direct source id of that token. */
const ASSET_HUB_DESTINATIONS: readonly WithdrawDestination[] = Object.freeze([
  assetHubDestination("dot-assethub", "DOT", "native"),
  assetHubDestination("dotusd-assethub", "dotUSD", "dotUSD"),
  assetHubDestination("usdt-assethub", "USDT", "USDT"),
  assetHubDestination("usdc-assethub", "USDC", "USDC"),
]);

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
        landing: "native" as const,
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
    destinations: ASSET_HUB_DESTINATIONS,
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

/** The Asset Hub account the funds land on for a destination: the address itself for Asset Hub.
 *  Null for a provider destination: the PAS lands on the withdrawal's own key, which then pays
 *  the provider and is where a refund comes back to. */
export function landingAccountHex(
  destination: WithdrawDestination,
  address: string,
): `0x${string}` | null {
  return destination.rail === "direct" ? assetHubAccountHex(address) : null;
}

/** Whether some other network's rule accepts the address: picks the wrong-network error over
 *  the plain malformed one. */
export function matchesOtherNetwork(network: WithdrawNetwork, address: string): boolean {
  const trimmed = address.trim();
  return WITHDRAW_NETWORKS.some(
    (other) =>
      other.chain !== network.chain &&
      other.destinations.some((destination) => destination.validateAddress(trimmed)),
  );
}

/** The address as the withdrawal frames elide it: five each end, against the six `shortAddress`
 *  leads with elsewhere. Same elision underneath, so only the frame's count lives here. */
export const shortDestinationAddress = (address: string): string =>
  elideMiddle(address.trim(), 5, 5);
