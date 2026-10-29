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
import { POLKADOT_CHAIN, SOURCE_CHAINS, sourceIdFor } from "~~/lib/config";

interface DestinationBase {
  /** The destination's id, the tail of the withdrawal's source id: `usdc-assethub`, `btc`. */
  id: string;
  /** The network as Chainflip and the icon set name it. */
  chain: string;
  chainLabel: string;
  asset: string;
  validateAddress(address: string): boolean;
}

/** Asset Hub itself, reached by the XCM alone. `landing` is what the CASH lands as there, named as
 *  the on-ramp names a deposit, from which the sale is decided at quote time. */
export interface DirectDestination extends DestinationBase {
  rail: "direct";
  landing: DepositAsset;
}

/** A destination a provider carries. It names no landing: it takes from the key whatever the sale
 *  its quote picked lands there, the PSM's external or the native. */
export interface ProviderDestination extends DestinationBase {
  rail: Exclude<WithdrawalRailState["provider"], "direct">;
  landing?: undefined;
}

export type WithdrawDestination = DirectDestination | ProviderDestination;

export interface WithdrawNetwork {
  chain: string;
  label: string;
  icon: string;
  destinations: readonly WithdrawDestination[];
}

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

/** One key per account: EVM addresses lowercased, SS58 ones by public key, anything else verbatim. */
export function addressKey(address: string): string {
  if (address.startsWith("0x")) return address.toLowerCase();
  try {
    return assetHubAccountHex(address);
  } catch {
    return address;
  }
}

const assetHubDestination = (id: string, asset: string, landing: DepositAsset): DirectDestination =>
  Object.freeze({
    id,
    chain: POLKADOT_CHAIN.chain,
    chainLabel: POLKADOT_CHAIN.label,
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
function chainflipDestinations(chain: string, assets: readonly string[]): ProviderDestination[] {
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
    chain: POLKADOT_CHAIN.chain,
    label: POLKADOT_CHAIN.label,
    icon: networkIcon(POLKADOT_CHAIN.chain),
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
 *  Null for a provider destination: the sale's token lands on the withdrawal's own key, which
 *  then pays the provider and is where a refund comes back to. */
export function landingAccountHex(
  destination: WithdrawDestination,
  address: string,
): `0x${string}` | null {
  return destination.rail === "direct" ? assetHubAccountHex(address) : null;
}

/** A figure in the landing asset as the summary shows it: four decimals, the trailing zeros
 *  dropped. */
export function formatLanding(units: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const whole = units / unit;
  const fraction = ((units % unit) * 10_000n) / unit;
  const digits = fraction.toString().padStart(4, "0").replace(/0+$/, "");
  return digits === "" ? whole.toString() : `${whole}.${digits}`;
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
