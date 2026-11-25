// Where a withdrawal can go: the network the picker shows, the tokens on it, and for each
// destination how an address is checked, what the CASH lands as on Asset Hub, and where. Asset
// Hub is the one network, reached by the XCM alone, in any of the tokens the on-ramp takes from
// Polkadot.

import { AccountId } from "polkadot-api";
import type { DepositAsset } from "@getsome/funding";
import { elideMiddle } from "../utils/address";
import { networkIcon, tokenIcon } from "../utils/icons";
import { POLKADOT_CHAIN } from "~~/lib/config";

/** A token on Asset Hub, reached by the XCM alone. */
export interface WithdrawDestination {
  /** The destination's id, the tail of the withdrawal's source id: `usdc-assethub`. */
  id: string;
  /** The network as the icon set names it. */
  chain: string;
  chainLabel: string;
  asset: string;
  /** What the CASH lands as, named as the on-ramp names a deposit, from which the sale is decided
   *  at quote time. */
  landing: DepositAsset;
  validateAddress(address: string): boolean;
}

export interface WithdrawNetwork {
  chain: string;
  label: string;
  icon: string;
  destinations: readonly WithdrawDestination[];
}

const accountId = AccountId();

/** A 20-byte Ethereum style account, which Asset Hub takes through its contracts pallet. */
export function isH160Address(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address.trim());
}

/** A 32-byte account in any SS58 prefix, or an H160. */
export function isAssetHubAddress(address: string): boolean {
  if (isH160Address(address)) return true;
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

/** The 32-byte account Asset Hub maps an H160 to, as SS58, asked of the chain. The contracts
 *  pallet picks the Polkadot account mapped to the H160, else the H160 padded with 0xEE. Asking
 *  the runtime keeps that rule in one place. */
export type H160AccountReader = (h160: `0x${string}`) => Promise<string>;

const assetHubDestination = (
  id: string,
  asset: string,
  landing: DepositAsset,
): WithdrawDestination =>
  Object.freeze({
    id,
    chain: POLKADOT_CHAIN.chain,
    chainLabel: POLKADOT_CHAIN.label,
    asset,
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

/** Asset Hub, the one network a withdrawal goes to. */
export const ASSET_HUB_NETWORK: WithdrawNetwork = Object.freeze({
  chain: POLKADOT_CHAIN.chain,
  label: POLKADOT_CHAIN.label,
  icon: networkIcon(POLKADOT_CHAIN.chain),
  destinations: ASSET_HUB_DESTINATIONS,
});

/** The networks a withdrawal can go to. */
export const WITHDRAW_NETWORKS: readonly WithdrawNetwork[] = Object.freeze([ASSET_HUB_NETWORK]);

export const withdrawNetwork = (chain: string): WithdrawNetwork | undefined =>
  WITHDRAW_NETWORKS.find((network) => network.chain === chain);

export const withdrawDestination = (id: string): WithdrawDestination | undefined =>
  WITHDRAW_NETWORKS.flatMap((network) => network.destinations).find(
    (destination) => destination.id === id,
  );

export const destinationTokenIcon = (destination: WithdrawDestination): string =>
  tokenIcon(destination.asset);

/** The Asset Hub account the funds land on: the address itself, an H160 read on the chain
 *  first. */
export async function landingAccountHex(
  address: string,
  readH160Account: H160AccountReader,
): Promise<`0x${string}`> {
  if (!isH160Address(address)) return assetHubAccountHex(address);
  const h160 = address.trim().toLowerCase() as `0x${string}`;
  return assetHubAccountHex(await readH160Account(h160));
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

/** The address as the withdrawal frames elide it: five each end, against the six `shortAddress`
 *  leads with elsewhere. Same elision underneath, so only the frame's count lives here. */
export const shortDestinationAddress = (address: string): string =>
  elideMiddle(address.trim(), 5, 5);
